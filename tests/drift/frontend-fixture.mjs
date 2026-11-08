// tests/drift/frontend-fixture.mjs — tiny hadrius_frontend-shaped git repo (real git, temp dir, no network).
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const VIEW_RULES = 'apps/hadrius-app/src/features/rules/view_rules.tsx';
export const NAV_BAR = 'apps/hadrius-app/src/app_shell/nav_bar.tsx';
export const RULE_PAGE = 'apps/hadrius-app/pages/rules/[ruleId].tsx';

export function makeFrontendRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'fe-'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  const write = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
  const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.hooksPath', '/dev/null');
  write('apps/hadrius-app/pages/_app.tsx', 'import { NavBar } from "src/app_shell/nav_bar";\nexport default function App() { return <NavBar />; }\n');
  write(NAV_BAR, 'export function NavBar() { return <nav><a>People Oversight</a><a>Marketing Review</a></nav>; }\n');
  write('apps/hadrius-app/pages/rules/index.tsx', 'import { RulesView } from "src/features/rules/view_rules";\nexport default function Page() { return <RulesView />; }\n');
  write(RULE_PAGE, 'export default function RulePage() { return <h1>Rule details</h1>; }\n');
  write(VIEW_RULES, 'import { Button } from "@1quantbase/pantheon/button";\nexport function RulesView() { return <section><h1>Trading Rules</h1><Button>Create rule</Button><p>Rules apply to every account</p></section>; }\n');
  write('packages/pantheon/src/button.tsx', 'export function Button(p: any) { return <button className="px-2 rounded">{p.children}</button>; }\n');
  write('apps/hadrius-app/src/features/other/view_other.tsx', 'export function Other() { return <p>Unrelated screen</p>; }\n');
  const A = commit('Base (#1)');
  write(VIEW_RULES, 'import { Button } from "@1quantbase/pantheon/button";\nexport function RulesView() { return <section><h1>Trading Rules</h1><Button>New rule</Button><Button>Import rules</Button><p>Rules apply to every account</p></section>; }\n');
  write(RULE_PAGE, 'export default function RulePage() { return <h1>Rule overview</h1>; }\n');
  const B = commit('Rules toolbar redesign (#2)');
  write('apps/hadrius-app/src/features/other/view_other.tsx', 'export function Other() { return <p>Unrelated screen v2</p>; }\n');
  const C = commit('Other screen tweak (#3)');
  write(NAV_BAR, 'export function NavBar() { return <nav><a>People</a><a>Marketing Review</a></nav>; }\n');
  const D = commit('Rename the People Oversight nav item (#4)');
  return { dir, gitDir: join(dir, '.git'), A, B, C, D };
}
