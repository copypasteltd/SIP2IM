import type { StatusSemantic } from '../../lib/status-map';
export function Status({ semantic, children }: { semantic: StatusSemantic; children: React.ReactNode }) { return <span className={'status status-' + semantic}><span className="status-dot" aria-hidden="true" />{children}</span>; }
