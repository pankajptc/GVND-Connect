import React from 'react';
import ReactDOM from 'react-dom/client';
import { MeshApp } from './components/mesh/MeshApp';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(<MeshApp />);
}
