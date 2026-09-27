import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/schibsted-grotesk/wght.css';
import '@fontsource-variable/martian-mono/wdth.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
