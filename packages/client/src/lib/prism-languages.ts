/**
 * Setup additional Prism languages for syntax highlighting
 *
 * prism-react-renderer only bundles these languages by default:
 * markup, jsx, tsx, swift, kotlin, objectivec, js-extras, reason, rust, graphql, yaml, go, cpp, markdown, python, json
 *
 * This file adds support for additional languages by importing them from prismjs.
 * Must be imported before using the Highlight component with these languages.
 */

// IMPORTANT: prism-setup must be imported first to set global Prism
// before any language components are loaded
import './prism-setup';

// Import additional language components
// These register themselves with the global Prism instance
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-scss';
import 'prismjs/components/prism-less';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-sql';
