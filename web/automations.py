"""Bounded local-file access for Codex's native automations, without a scheduler."""
import calendar
import datetime
import errno
import json
import math
import os
import re
import sqlite3
import stat
import sys
import time
import tomllib
import uuid
from contextlib import contextmanager
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

LIMIT = 256 * 1024
SAFE_INT = 2 ** 53 - 1
DEFAULT_RULE = "FREQ=HOURLY;INTERVAL=24;BYMINUTE=0"
FIELDS = {
    "kind": "kind", "name": "name", "prompt": "prompt", "status": "status", "rrule": "rrule",
    "targetThreadId": "target_thread_id", "cwds": "cwds", "executionEnvironment": "execution_environment",
    "model": "model", "reasoningEffort": "reasoning_effort", "projectId": "target",
}
OWNERS = ("account_id", "user_id", "installation_id")
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


class AutomationError(Exception):
    def __init__(self, code, status, message):
        self.error = {"code": "AUTOMATION_" + code, "status": status, "message": message}


def invalid():
    raise AutomationError("INVALID", 400, "Invalid automation data.")


def conflict():
    raise AutomationError("CONFLICT", 409, "This automation changed. Reload it before saving.")


def integer(value):
    return type(value) is int and 0 <= value <= SAFE_INT


def identifier(value):
    if (not isinstance(value, str) or not value.strip() or value in (".", "..")
            or any(c in value for c in ("/", "\\")) or re.search(r"[\x00-\x1f\x7f]", value)
            or len(value.encode("utf-8")) > 255):
        raise AutomationError("INVALID_ID", 400, "Invalid automation ID.")
    return value


def filesystem_error(error, home=False):
    if home:
        raise AutomationError("UNAVAILABLE", 503, "The native Codex home is unavailable.")
    if error.errno == errno.ENOENT:
        raise AutomationError("NOT_FOUND", 404, "Automation not found.")
    if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.EISDIR, errno.ENXIO):
        raise AutomationError("UNSAFE_PATH", 400, "Unsafe automation path.")
    raise AutomationError("UNAVAILABLE", 503, "Native automation storage is unavailable.")


def open_directory(name, parent=None):
    try:
        return os.open(name, DIR_FLAGS, dir_fd=parent)
    except OSError as error:
        filesystem_error(error)


def open_home(path):
    if not isinstance(path, str) or not os.path.isabs(path) or "\0" in path:
        raise AutomationError("UNAVAILABLE", 503, "The native Codex home is unavailable.")
    fd = os.open(os.path.sep, DIR_FLAGS)
    try:
        for part in path.split(os.path.sep):
            if not part or part == ".":
                continue
            if part == "..":
                raise AutomationError("UNAVAILABLE", 503, "The native Codex home is unavailable.")
            next_fd = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except OSError as error:
        os.close(fd)
        filesystem_error(error, home=True)
    except Exception:
        os.close(fd)
        raise


def regular_file(parent, name, optional=False):
    try:
        fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    except OSError as error:
        if optional and error.errno == errno.ENOENT:
            return None
        filesystem_error(error)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise AutomationError("UNSAFE_PATH", 400, "Unsafe automation path.")
    return fd


def read_file(parent):
    fd = regular_file(parent, "automation.toml")
    with os.fdopen(fd, "rb") as stream:
        if os.fstat(stream.fileno()).st_size > LIMIT:
            raise AutomationError("TOO_LARGE", 413, "Automation configuration is too large.")
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise AutomationError("TOO_LARGE", 413, "Automation configuration is too large.")
    try:
        return tomllib.loads(data.decode("utf-8")), data
    except (ValueError, UnicodeError):
        raise AutomationError("INVALID_FILE", 400, "Invalid native automation configuration.")


def native_item(raw, task_id):
    if type(raw.get("version", 1)) is not int or raw.get("version", 1) != 1:
        raise AutomationError("UNSUPPORTED_VERSION", 409, "Unsupported native automation version.")
    if raw.get("id") != task_id:
        raise AutomationError("INVALID_FILE", 400, "Invalid native automation configuration.")
    kind = raw.get("kind", "cron")
    if kind not in ("cron", "heartbeat") or raw.get("status") not in ("ACTIVE", "PAUSED"):
        invalid()
    for field in ("name", "prompt"):
        if not isinstance(raw.get(field), str):
            invalid()
    if not integer(raw.get("created_at")) or not integer(raw.get("updated_at")):
        invalid()
    rule = raw.get("rrule", DEFAULT_RULE)
    if not isinstance(rule, str):
        invalid()
    for field in ("model", "reasoning_effort"):
        if field in raw and not isinstance(raw[field], str):
            invalid()
    item = {
        "id": task_id, "kind": kind, "name": raw["name"], "prompt": raw["prompt"], "status": raw["status"],
        "rrule": rule.strip() or DEFAULT_RULE, "targetThreadId": None, "projectId": None, "cwds": [], "executionEnvironment": None,
        "model": raw.get("model", "").strip() or None, "reasoningEffort": raw.get("reasoning_effort"),
        "createdAt": raw["created_at"], "updatedAt": raw["updated_at"], "nextRunAt": None, "lastRunAt": None,
    }
    if kind == "heartbeat":
        if not isinstance(raw.get("target_thread_id"), str) or not raw["target_thread_id"].strip():
            invalid()
        item["targetThreadId"] = raw["target_thread_id"]
    else:
        if not isinstance(raw.get("cwds"), list) or any(not isinstance(cwd, str) for cwd in raw["cwds"]):
            invalid()
        environment = raw.get("execution_environment", "worktree")
        if environment not in ("local", "worktree"):
            invalid()
        target = raw.get("target")
        if target is not None:
            if not isinstance(target, dict) or target.get("type") not in ("project", "projectless"):
                invalid()
            if target["type"] == "project":
                if not isinstance(target.get("project_id"), str) or not target["project_id"].strip():
                    invalid()
                item["projectId"] = target["project_id"]
        item.update(cwds=raw["cwds"], executionEnvironment=environment)
    return item


def date_value(value):
    if not re.fullmatch(r"\d{8}(?:T\d{6}Z?)?", value):
        invalid()
    try:
        return datetime.datetime.strptime(value.rstrip("Z"), "%Y%m%dT%H%M%S" if "T" in value else "%Y%m%d")
    except ValueError:
        invalid()


def validate_rule(rule):
    if not isinstance(rule, str) or not rule.strip() or len(rule) > 8192:
        invalid()
    rules, start, positive, simple = [], None, False, True
    rdates, has_rule = [], False
    ranges = {"BYSECOND": (0, 60), "BYMINUTE": (0, 59), "BYHOUR": (0, 23), "BYMONTH": (1, 12),
              "BYMONTHDAY": (-31, 31), "BYYEARDAY": (-366, 366), "BYWEEKNO": (-53, 53), "BYSETPOS": (-366, 366)}
    days = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
    for line in rule.strip().splitlines():
        line = line.strip()
        match = re.fullmatch(r"(DTSTART|RDATE|EXDATE)(?:;TZID=([^:;]+))?:(.+)", line, re.I)
        if match:
            name, tzid, dates = match.groups()
            if tzid:
                try:
                    ZoneInfo(tzid)
                except (ZoneInfoNotFoundError, ValueError):
                    invalid()
            for value in dates.split(","):
                parsed_date = date_value(value)
                if tzid and value.endswith("Z"):
                    invalid()
                parsed_date = parsed_date.replace(tzinfo=ZoneInfo(tzid) if tzid else datetime.timezone.utc)
                if name.upper() == "RDATE":
                    rdates.append(parsed_date)
            if name.upper() == "DTSTART":
                if start is not None or "," in dates:
                    invalid()
                start = parsed_date
            else:
                simple = False
                positive = positive or name.upper() == "RDATE"
            continue
        if line.upper().startswith(("RRULE:", "EXRULE:")):
            exclusion = line.upper().startswith("EXRULE:")
            simple = simple and not exclusion
            positive = positive or not exclusion
            has_rule = has_rule or not exclusion
            line = line.split(":", 1)[1]
        else:
            positive = True
            has_rule = True
        options = {}
        for part in line.split(";"):
            pair = part.split("=", 1)
            if len(pair) != 2 or not pair[1] or pair[0].upper() in options:
                invalid()
            key, value = pair[0].upper(), pair[1].upper()
            options[key] = value
            if key == "FREQ":
                if value not in ("YEARLY", "MONTHLY", "WEEKLY", "DAILY", "HOURLY", "MINUTELY", "SECONDLY"):
                    invalid()
            elif key in ("INTERVAL", "COUNT"):
                if not re.fullmatch(r"\d{1,16}", value, re.ASCII) or not 0 < int(value) <= SAFE_INT:
                    invalid()
            elif key in ranges or key == "BYEASTER":
                lower, upper = ranges.get(key, (-366, 366))
                for number in value.split(","):
                    if not re.fullmatch(r"[+-]?\d{1,3}", number) or not lower <= int(number) <= upper:
                        invalid()
                    if int(number) == 0 and key in ("BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYSETPOS"):
                        invalid()
            elif key == "BYDAY":
                for day in value.split(","):
                    m = re.fullmatch(r"([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)", day)
                    if not m or m[1] is not None and not 0 < abs(int(m[1])) <= 53:
                        invalid()
            elif key == "WKST":
                if value not in days:
                    invalid()
            elif key == "UNTIL":
                date_value(value)
            else:
                invalid()
        if "FREQ" not in options:
            invalid()
        if "BYMONTH" in options and "BYMONTHDAY" in options:
            longest = max(calendar.monthrange(2000, int(month))[1] for month in options["BYMONTH"].split(","))
            if all(abs(int(day)) > longest for day in options["BYMONTHDAY"].split(",")):
                invalid()
        rules.append(options)
    if not positive:
        invalid()
    now = time.time()
    if simple and len(rules) == 1 and "UNTIL" in rules[0] and date_value(rules[0]["UNTIL"]).replace(tzinfo=datetime.timezone.utc).timestamp() <= now:
        invalid()
    if not has_rule and rdates and all(date.timestamp() <= now for date in rdates):
        invalid()
    if simple and len(rules) == 1 and rules[0].get("COUNT") == "1" and start is None and not {"BYHOUR", "BYMINUTE"} <= rules[0].keys():
        invalid()
    if start is not None and any(rule.get("COUNT") == "1" for rule in rules) and start.timestamp() <= now:
        invalid()


def apply_patch(raw, patch, creating=False):
    if not isinstance(patch, dict) or set(patch) - FIELDS.keys():
        invalid()
    kind = patch.get("kind", raw.get("kind", "cron"))
    if kind not in ("cron", "heartbeat") or not creating and "kind" in patch and patch["kind"] != raw.get("kind", "cron"):
        invalid()
    for key, value in patch.items():
        if key in ("name", "prompt", "rrule", "targetThreadId"):
            if not isinstance(value, str) or not value.strip():
                invalid()
            if len(value.encode("utf-8")) > LIMIT:
                raise AutomationError("TOO_LARGE", 413, "Automation configuration is too large.")
        elif key == "status" and value not in ("ACTIVE", "PAUSED"):
            invalid()
        elif key == "executionEnvironment" and value not in ("local", "worktree"):
            invalid()
        elif key == "cwds":
            if not isinstance(value, list) or len(value) > 128 or any(not isinstance(cwd, str) or not cwd.strip() or "\0" in cwd for cwd in value):
                invalid()
        elif key in ("model", "reasoningEffort", "projectId"):
            if value is not None and (not isinstance(value, str) or not value.strip() or "\0" in value):
                invalid()
            if key == "reasoningEffort" and value is not None and value not in ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"):
                invalid()
        if kind == "heartbeat" and key in ("cwds", "projectId", "executionEnvironment") or kind == "cron" and key == "targetThreadId":
            invalid()
        if key == "rrule" and (creating or value.strip() != raw.get("rrule", DEFAULT_RULE).strip()):
            validate_rule(value)
        if key == "projectId":
            target = dict(raw.get("target") or {})
            target["type"] = "projectless" if value is None else "project"
            if value is None:
                target.pop("project_id", None)
            else:
                target["project_id"] = value
            raw["target"] = target
        elif value is None:
            raw.pop(FIELDS[key], None)
        else:
            raw[FIELDS[key]] = value
    if creating and not {"kind", "name", "prompt", "rrule"} <= patch.keys():
        invalid()
    return raw


def toml_value(value):
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is int:
        return str(value)
    if type(value) is float:
        return ("-inf" if value < 0 else "inf") if math.isinf(value) else "nan" if math.isnan(value) else repr(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(entry) for entry in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(json.dumps(key, ensure_ascii=False) + " = " + toml_value(entry) for key, entry in value.items()) + " }"
    invalid()


def encoded(raw):
    result = ("\n".join(json.dumps(key, ensure_ascii=False) + " = " + toml_value(value) for key, value in raw.items()) + "\n").encode("utf-8")
    if len(result) > LIMIT:
        raise AutomationError("TOO_LARGE", 413, "Automation configuration is too large.")
    # Reparse before replacing anything; unknown TOML values must survive serialization.
    tomllib.loads(result.decode("utf-8"))
    return result


class Store:
    def __init__(self, home):
        self.home = home
        self.home_fd = open_home(home)

    @contextmanager
    def root(self, create=False):
        if create:
            try:
                os.mkdir("automations", 0o700, dir_fd=self.home_fd)
            except FileExistsError:
                pass
        fd = open_directory("automations", self.home_fd)
        try:
            yield fd
        finally:
            os.close(fd)

    @contextmanager
    def task(self, task_id):
        identifier(task_id)
        with self.root() as root:
            fd = open_directory(task_id, root)
            try:
                yield fd, root
            finally:
                os.close(fd)

    @contextmanager
    def databases(self, write=False):
        connections, handles = [], []
        try:
            try:
                root = os.open("sqlite", DIR_FLAGS, dir_fd=self.home_fd)
            except FileNotFoundError:
                yield connections
                return
            handles.append(root)
            for name in ("codex.db", "codex-dev.db"):
                fd = regular_file(root, name, optional=True)
                if fd is None:
                    continue
                handles.append(fd)
                for suffix in ("-wal", "-shm", "-journal"):
                    sidecar = regular_file(root, name + suffix, optional=True)
                    if sidecar is not None:
                        handles.append(sidecar)
                path = f"/proc/self/fd/{fd}" if os.path.isdir("/proc/self/fd") else os.path.join(self.home, "sqlite", name)
                connection = sqlite3.connect("file:" + quote(path) + ("?mode=rw" if write else "?mode=ro"), uri=True, timeout=1)
                connections.append(connection)
                if not write:
                    connection.execute("PRAGMA query_only = ON")
            yield connections
        except (OSError, sqlite3.Error):
            raise AutomationError("CACHE_UNAVAILABLE", 503, "Native automation runtime state is unavailable.")
        finally:
            for connection in connections:
                connection.close()
            for fd in handles:
                os.close(fd)

    @staticmethod
    def cache_rows(connections):
        rows = []
        for connection in connections:
            columns = {row[1] for row in connection.execute("PRAGMA table_info(automations)")}
            if not columns:
                continue
            if "id" not in columns:
                raise AutomationError("CACHE_UNAVAILABLE", 503, "Native automation runtime state is unavailable.")
            selected = [key for key in ("id", "next_run_at", "last_run_at", "status", "rrule", "legacy_automation_id", *OWNERS) if key in columns]
            rows.extend(dict(zip(selected, row)) for row in connection.execute("SELECT " + ", ".join(selected) + " FROM automations"))
        return rows

    def cache(self):
        with self.databases() as connections:
            return self.cache_rows(connections)

    @staticmethod
    def runtime(item, rows):
        matches = [row for row in rows if row["id"] == item["id"] or row.get("legacy_automation_id") == item["id"]]
        if any(any(row.get(key) is not None for key in OWNERS) for row in matches):
            raise AutomationError("CLOUD_MANAGED", 409, "This automation is managed by native account sync.")
        row = next((row for row in matches if row["id"] == item["id"]), {})
        for public, native in (("nextRunAt", "next_run_at"), ("lastRunAt", "last_run_at")):
            value = row.get(native)
            item[public] = value if integer(value) else None
        if item["status"] != "ACTIVE" or row.get("status") != item["status"] or (row.get("rrule") or DEFAULT_RULE).strip() != item["rrule"]:
            item["nextRunAt"] = None
        return item

    def list(self):
        items, unavailable = [], []
        try:
            rows = self.cache()
        except AutomationError as error:
            rows = []
            unavailable.append(error.error)
        if any(any(row.get(key) is not None for key in OWNERS) for row in rows):
            unavailable.append({"code": "AUTOMATION_LOCAL_ONLY", "status": 409,
                                "message": "Account-synced automations must be managed in native Codex."})
        try:
            with self.root() as root:
                with os.scandir(root) as entries:
                    names = [entry.name for entry in entries if entry.is_dir(follow_symlinks=False) or entry.is_symlink()]
                for task_id in names:
                    try:
                        identifier(task_id)
                        fd = open_directory(task_id, root)
                        try:
                            raw, _ = read_file(fd)
                        finally:
                            os.close(fd)
                        item = self.runtime(native_item(raw, task_id), rows)
                        item["promptPreview"] = re.sub(r"\s+", " ", item.pop("prompt")).strip()[:240]
                        items.append(item)
                    except AutomationError as error:
                        if error.error["code"] != "AUTOMATION_NOT_FOUND":
                            unavailable.append({"id": task_id, **error.error})
        except AutomationError as error:
            if error.error["code"] != "AUTOMATION_NOT_FOUND":
                unavailable.append(error.error)
        return {"items": sorted(items, key=lambda item: (-item["updatedAt"], item["id"])), "unavailable": unavailable}

    def read(self, task_id):
        with self.task(task_id) as (fd, _):
            raw, _ = read_file(fd)
            return {"item": self.runtime(native_item(raw, task_id), self.cache())}

    @staticmethod
    def persist(fd, raw, previous=None):
        output = encoded(raw)
        temporary = ".automation.toml.tmp-" + uuid.uuid4().hex
        target = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            with os.fdopen(target, "wb") as stream:
                stream.write(output)
                stream.flush()
                os.fsync(stream.fileno())
            # shortcut: native Codex does not share a CAS lock; use a native CAS RPC when one becomes available.
            if previous is not None and read_file(fd)[1] != previous:
                conflict()
            os.replace(temporary, "automation.toml", src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=fd)
            except FileNotFoundError:
                pass

    def create(self, patch):
        now = time.time_ns() // 1000000
        raw = {"version": 1, "status": "ACTIVE", "created_at": now, "updated_at": now}
        apply_patch(raw, patch, creating=True)
        if raw["kind"] == "cron":
            raw.setdefault("cwds", [])
            raw.setdefault("execution_environment", "local")
            raw.setdefault("target", {"type": "projectless"})
        slug = re.sub(r"[^a-z0-9]+", "-", raw["name"].lower()).strip("-")[:128].rstrip("-") or "automation"
        rows = self.cache()
        reserved = {row["id"] for row in rows} | {row["legacy_automation_id"] for row in rows if row.get("legacy_automation_id")}
        with self.root(create=True) as root:
            for number in range(1, 10002):
                task_id = slug if number == 1 else slug + "-" + str(number)
                if task_id in reserved:
                    continue
                raw["id"] = task_id
                item = native_item(raw, task_id)
                encoded(raw)
                try:
                    os.mkdir(task_id, 0o700, dir_fd=root)
                except FileExistsError:
                    continue
                fd = open_directory(task_id, root)
                try:
                    self.persist(fd, raw)
                except Exception:
                    try:
                        os.rmdir(task_id, dir_fd=root)
                    except OSError:
                        pass
                    raise
                finally:
                    os.close(fd)
                return {"item": item}
        raise AutomationError("UNAVAILABLE", 503, "No automation ID is available.")

    @staticmethod
    def expected(raw, value):
        if not integer(value):
            invalid()
        if value != raw["updated_at"]:
            conflict()

    def update(self, task_id, expected, patch):
        with self.task(task_id) as (fd, _):
            raw, previous = read_file(fd)
            rows = self.cache()
            self.runtime(native_item(raw, task_id), rows)
            self.expected(raw, expected)
            apply_patch(raw, patch)
            raw["updated_at"] = max(time.time_ns() // 1000000, raw["updated_at"] + 1)
            updated = self.runtime(native_item(raw, task_id), rows)
            self.persist(fd, raw, previous)
            return {"item": updated}

    def delete(self, task_id, expected, confirmed):
        identifier(task_id)
        if confirmed is not True:
            raise AutomationError("CONFIRM_REQUIRED", 400, "Confirm automation deletion.")
        with self.task(task_id) as (fd, root):
            raw, previous = read_file(fd)
            item = native_item(raw, task_id)
            self.expected(raw, expected)
            with self.databases(write=True) as connections:
                for connection in connections:
                    connection.execute("BEGIN IMMEDIATE")
                self.runtime(item, self.cache_rows(connections))
                for connection in connections:
                    columns = {row[1] for row in connection.execute("PRAGMA table_info(automations)")}
                    if not columns:
                        continue
                    # Native run/thread records outlive deletion of their automation configuration.
                    connection.set_authorizer(lambda action, table, _column, _db, _trigger:
                        sqlite3.SQLITE_DENY if action in (sqlite3.SQLITE_DELETE, sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE) and (table != "automations" or _trigger is not None) else sqlite3.SQLITE_OK)
                    scope = " AND ".join(key + " IS NULL" for key in OWNERS if key in columns)
                    connection.execute("DELETE FROM automations WHERE id = ?" + (" AND " + scope if scope else ""), (task_id,))
                if read_file(fd)[1] != previous:
                    conflict()
                os.unlink("automation.toml", dir_fd=fd)
                os.fsync(fd)
                for connection in connections:
                    connection.commit()
            try:
                os.rmdir(task_id, dir_fd=root)
            except OSError as error:
                if error.errno not in (errno.ENOTEMPTY, errno.EEXIST):
                    raise
        return {"deleted": True, "id": task_id}


def main():
    store, request = None, {}
    try:
        data = sys.stdin.buffer.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise AutomationError("TOO_LARGE", 413, "Automation request is too large.")
        request = json.loads(data)
        store = Store(request.get("home"))
        action = request.get("action")
        if action == "list":
            result = store.list()
        elif action == "read":
            result = store.read(request.get("id"))
        elif action == "create":
            result = store.create(request.get("item"))
        elif action == "update":
            result = store.update(request.get("id"), request.get("expectedUpdatedAt"), request.get("patch"))
        elif action == "delete":
            result = store.delete(request.get("id"), request.get("expectedUpdatedAt"), request.get("confirmed"))
        else:
            invalid()
        response = {"result": result}
    except AutomationError as error:
        response = {"result": {"items": [], "unavailable": [error.error]}} if request.get("action") == "list" else {"error": error.error}
    except Exception:
        response = {"error": {"code": "AUTOMATION_UNAVAILABLE", "status": 503, "message": "Native automations are unavailable."}}
    finally:
        if store is not None:
            os.close(store.home_fd)
    print(json.dumps(response, ensure_ascii=False))


if __name__ == "__main__":
    main()
