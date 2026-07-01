#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname, '../..');
const cliDir = __dirname;

// ── Step 1: Build all internal TypeScript packages ──
console.log('\n🔨 Step 1: Building internal packages...');
const buildOrder = [
  'build:core',
  'build:providers',
  'build:estimators',
  'build:budget-engine',
  'build:context-engine',
  'build:prompt-optimizer',
  'build:routing-engine',
  'build:telemetry',
  'build:terminal-ui',
  'build:gateway',
];
for (const script of buildOrder) {
  console.log(`   npm run ${script}`);
  execSync(`npm run ${script}`, { cwd: rootDir, stdio: 'inherit' });
}

// ── Step 2: Build dashboard and copy into cli/dashboard/ ──
console.log('\n🎨 Step 2: Building dashboard...');
const dashboardSrc = path.join(rootDir, 'apps/dashboard');
const dashboardDist = path.join(dashboardSrc, 'dist');
const cliDashboard = path.join(cliDir, 'dashboard');

try {
  execSync('npm run build', { cwd: dashboardSrc, stdio: 'inherit' });
} catch {
  console.warn('   ⚠ Dashboard build failed – skipping dashboard packaging.');
}

if (fs.existsSync(dashboardDist)) {
  console.log('   Copying dashboard assets...');
  if (fs.existsSync(cliDashboard)) fs.rmSync(cliDashboard, { recursive: true, force: true });
  copyDir(dashboardDist, cliDashboard);
  console.log('   ✔ Dashboard copied.');
} else {
  console.warn('   ⚠ No dashboard build output found.');
}

// ── Step 3: Bundle CLI with esbuild ──
console.log('\n📦 Step 3: Bundling CLI with esbuild...');

let esbuild;
try {
  esbuild = require(path.join(rootDir, 'node_modules/esbuild'));
} catch {
  try { esbuild = require('esbuild'); } catch {
    console.error('   ❌ esbuild not found. Run "npm install" from the repo root first.');
    process.exit(1);
  }
}

// Plugin to bypass Yarn PnP resolution that a parent-directory .pnp.cjs imposes.
// Resolves @tokenwall/* to compiled dist files and all other bare specifiers
// via Node's own require.resolve (which follows the npm workspace symlinks).
const builtinModules = require('module').builtinModules;
const workspaceResolverPlugin = {
  name: 'workspace-resolver',
  setup(build) {
    // Map @tokenwall packages directly to their compiled dist entry points
    const tokenwallMap = {};
    const pkgDirs = fs.readdirSync(path.join(rootDir, 'packages'));
    for (const dir of pkgDirs) {
      const pkgJsonPath = path.join(rootDir, 'packages', dir, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        if (pkg.name && pkg.name.startsWith('@tokenwall/')) {
          const main = pkg.main || 'dist/index.js';
          tokenwallMap[pkg.name] = path.resolve(rootDir, 'packages', dir, main);
        }
      }
    }
    // Also add the gateway
    const gwPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'apps/gateway/package.json'), 'utf8'));
    tokenwallMap[gwPkg.name] = path.resolve(rootDir, 'apps/gateway', gwPkg.main || 'dist/index.js');

    console.log('   Workspace packages mapped:');
    for (const [name, p] of Object.entries(tokenwallMap)) {
      console.log(`     ${name} → ${path.relative(rootDir, p)}`);
    }

    build.onResolve({ filter: /.*/ }, (args) => {
      // Skip relative and absolute paths — let esbuild handle them naturally
      if (args.path.startsWith('.') || args.path.startsWith('/')) return null;

      // Skip Node.js built-in modules
      const bare = args.path.replace(/^node:/, '');
      if (builtinModules.includes(bare)) return null;

      // Skip explicit externals
      if (args.path === 'better-sqlite3' || args.path.startsWith('magika') || args.path.startsWith('@swc')) return null;

      // Resolve @tokenwall/* directly to compiled dist
      if (tokenwallMap[args.path]) {
        return { path: tokenwallMap[args.path] };
      }

      // For everything else, resolve via Node's require.resolve (bypasses PnP)
      try {
        const resolved = require.resolve(args.path, {
          paths: [
            args.resolveDir, // relative to the file doing the import
            path.join(rootDir, 'node_modules'),
            path.join(rootDir, 'apps/gateway/node_modules'),
          ]
        });
        return { path: resolved };
      } catch {
        return null; // fall back to esbuild default
      }
    });
  }
};

const outFile = path.join(cliDir, 'dist/index.js');

(async () => {
  await esbuild.build({
    entryPoints: [path.join(cliDir, 'src/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    outfile: outFile,
    external: ['better-sqlite3', 'magika', 'magika/*', '@swc/core', '@swc/wasm', '@swc/*', '*.node'],
    format: 'cjs',
    logLevel: 'info',
    plugins: [workspaceResolverPlugin],
  });

  // ── Step 4: Verify the bundle ──
  console.log('\n🔍 Step 4: Verifying bundle...');
  const bundle = fs.readFileSync(outFile, 'utf8');
  const leaks = bundle.match(/require\(["']@tokenwall\//g);
  if (leaks && leaks.length > 0) {
    console.error('   ❌ Bundle still contains external @tokenwall/* requires:');
    leaks.forEach(l => console.error('      ' + l));
    console.error('   The globally-installed package will fail at runtime.');
    process.exit(1);
  }

  const sizeKB = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`   ✅ All @tokenwall/* packages inlined successfully.`);
  console.log(`   Bundle size: ${sizeKB} KB\n`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});

// ── Helpers ──
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    fs.statSync(s).isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

