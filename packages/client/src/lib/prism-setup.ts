/**
 * Initialize Prism global instance
 * Must be imported before any prismjs language components
 */
import { Prism } from 'prism-react-renderer';

// Make Prism available globally so language components can register themselves
(globalThis as unknown as { Prism: typeof Prism }).Prism = Prism;

export { Prism };
