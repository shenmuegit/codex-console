import React, { useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { connect } from '@isola/plugin';
import { Pane } from '@isola/plugin/ui';
import '@isola/plugin/styles.css';
import '../public/styles.css';
import originalHtml from '../public/index.html?raw';
import { startPlugin } from './bootstrap.mjs';

const original = new DOMParser().parseFromString(originalHtml, 'text/html');
original.querySelector('.sidebar-header .wordmark')?.remove();
const body = original.body.innerHTML;

function Console() {
  const content = useRef(null);
  useLayoutEffect(() => {
    const handle = startPlugin({ backendOrigin: import.meta.env.VITE_CODEX_CONSOLE_BACKEND_URL, connect });
    handle.ready.catch(error => {
      const message = content.current?.querySelector('#login-error');
      if (message) message.textContent = error.message;
    });
    return () => handle.dispose();
  }, []);
  return <Pane label="Codex Console"><div ref={content} dangerouslySetInnerHTML={{ __html: body }} /></Pane>;
}

createRoot(document.getElementById('root')).render(<Console />);
