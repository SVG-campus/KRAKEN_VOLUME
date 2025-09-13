import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

let mount =
  document.getElementById('root') ||
  document.getElementById('app');

if (!mount) {
  mount = document.createElement('div');
  mount.id = 'root';
  document.body.appendChild(mount);
}

createRoot(mount).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
