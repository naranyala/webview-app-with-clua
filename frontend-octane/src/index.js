import { createRoot } from 'octane';
import { App } from './App.tsrx';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
