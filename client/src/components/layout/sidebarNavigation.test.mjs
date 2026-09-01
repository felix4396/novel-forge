import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

function readLayoutSource(relativePath) {
  return readFileSync(join(currentDir, relativePath), "utf8");
}

function readClientSource(relativePath) {
  return readFileSync(join(currentDir, "../..", relativePath), "utf8");
}

test("model routes are reached from settings rather than the global sidebar", () => {
  const sidebarSource = readLayoutSource("Sidebar.tsx");
  const settingsNavigationSource = readClientSource("pages/settings/components/SettingsNavigationCards.tsx");

  assert.match(
    sidebarSource,
    /\{ to: "\/settings", label: "系统设置", icon: Settings2, end: true \}/,
    "settings sidebar item should use exact matching",
  );
  assert.doesNotMatch(
    sidebarSource,
    /to: "\/settings\/model-routes"/,
    "model routes should not appear as a separate global sidebar item",
  );
  assert.match(
    sidebarSource,
    /<NavLink key=\{item\.to\} to=\{item\.to\} end=\{item\.end\}/,
    "sidebar links should pass exact matching through to NavLink",
  );
  assert.match(
    settingsNavigationSource,
    /<Link to="\/settings\/model-routes">进入模型路由管理<\/Link>/,
    "settings page should keep model route management as an internal configuration entry",
  );
});
