// The two projects' marks, the files their READMEs show: copies of iridia's docs/logo.svg (Kalmarv/iridia
// 054339a) and dx's docs/logo.svg (Kalmarv/dx 4c2de56); replace a copy when its project's changes.
import dxMark from './assets/dx-logo.svg?url';
import iridiaMark from './assets/iridia-logo.svg?url';

export interface Project {
  name: string;
  mark: string;
  /** The mark's own size (its viewBox), for its aspect. */
  size: [number, number];
  repo: string;
  crates: string;
}

export const IRIDIA: Project = { name: 'iridia', mark: iridiaMark, size: [91, 80], repo: 'https://github.com/Kalmarv/iridia', crates: 'https://crates.io/crates/iridia' };
export const DX: Project = { name: 'dx', mark: dxMark, size: [102, 102], repo: 'https://github.com/Kalmarv/dx', crates: 'https://crates.io/crates/dxcontainer' };
