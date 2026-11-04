# Truck Packer 3D

A professional 3D truck packing visualization tool for planning equipment loads, tours, and
logistics. Built with Three.js for real-time 3D rendering and interactive packing simulations.

**Cargo Planner 3D supports both manual load planning and automated AutoPack recommendations.** The Editor remains manually authorable while the application separately evaluates physical and handling concerns. You can author, revise, and save loads freely—whether they assess as valid, incomplete, or needing attention—while AutoPack assists with suggestions and planning optimizations.

![Truck Packer 3D](https://img.shields.io/badge/Three.js-0.185.1-049EF4?logo=three.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

- **3D Interactive Editor**: Real-time visualization with orbit controls, zoom, and pan
- **Pack Management**: Create, organize, and manage multiple truck packing projects
- **Case Library**: Build a reusable library of equipment cases with custom dimensions and colors
- **Auto-Pack Engine**: Intelligent automatic packing algorithm to optimize space utilization
- **Export/Import**: Save and share packs as JSON, export to PDF and Excel
- **Dark/Light Theme**: Modern UI with theme switching
- **Grid & Shadows**: Toggle visual aids for better spatial awareness
- **Keyboard Shortcuts**: Efficient workflow with comprehensive keyboard controls
- **Hardened Imports**: npm-owned Three.js/OrbitControls runtime and sanitized JSON imports

## Quick Start

1. **Use the supported Node toolchain**: Node `^20.19.0` or `>=22.12.0` (the Vite 8 requirement).
2. **Install reproducibly**: Run `npm ci`.
3. **Start development**: Run `npm run dev`.
4. **Open the app**: Visit `http://localhost:5500/index.html`.
5. **Create a pack**: Click "New Pack" on the Packs screen.
6. **Add cases**: Go to Cases library and create equipment cases with dimensions.
7. **Start packing**: Open your pack in the Editor and drag cases from the sidebar to the 3D truck.
8. **Export**: Save your work as JSON or export to PDF/Excel for sharing.

## Development and Production Builds

Three.js is pinned to r185 (`0.185.1`) and delivered through npm and Vite. Three.js and OrbitControls
are bundled into application-owned production assets; the running app does not depend on a
third-party Three.js CDN.

- `npm ci` installs the exact dependency graph from `package-lock.json`.
- `npm run dev` starts Vite at `http://localhost:5500/index.html`.
- `npm run build` creates the static production output in `dist/`.
- `npm run preview` serves the built output at `http://localhost:5500/index.html` after the
  development server is stopped.

The `dist/` directory is a static deployment artifact. No application server or server-side
rendering runtime is required.

## Phase 1 (SaaS-Ready Foundation)

Phase 1 introduces a session/org foundation, plan/role-aware feature flags, and hash routing. See
`docs/archive/2026-02-phase1/MIGRATION_PHASE1.md` for historical details.

## Keyboard Shortcuts

Shortcuts act only where the app owns them. Everywhere else the browser keeps its own
behavior: text editing, Find, Reload, Bookmark, Save Page and Open File are never taken
over. On macOS use `Cmd` for `Ctrl` and `Option` (⌥) for `Alt`.

### Editor

Active on the Editor screen while focus is not in a text field, dialog or open dropdown.

- `Ctrl/Cmd + Z` - Undo
- `Ctrl/Cmd + Shift + Z` - Redo
- `Ctrl/Cmd + A` - Select all cases in the load plan
- `Ctrl/Cmd + C` - Copy selected cases (with cases selected; otherwise normal Copy)
- `Ctrl/Cmd + V` - Paste copied cases (after copying cases; otherwise normal Paste)
- `Ctrl/Cmd + D` - Duplicate selected cases
- `Esc` - Deselect all

### 3D viewport

Active while the 3D viewport has focus (click it, or reach it with `Tab` / `Shift + Tab`).
These are bare keys: with `Ctrl/Cmd` held they stay browser shortcuts (`Ctrl/Cmd + F` is Find).

- `R` - Turn (rotate 90° around Y)
- `T` - Tip (rotate 90° around X)
- `E` - Roll (rotate 90° around Z)
- `F` - Flip (180°)
- `Arrow keys` - Nudge 1 inch (`Shift + Arrow`: 6 inches)
- `Alt/Option + ↑` / `Alt/Option + ↓` - Move to the next valid level up / down
- `Alt/Option + Shift + ↓` - Drop to the nearest valid surface
- `Enter` - Place a held case
- `Esc` - Cancel a held case or an active drag
- `Delete` / `Backspace` - Delete selected cases
- `G` - Toggle grid visibility
- `S` - Toggle shadows

Holding an arrow key keeps nudging. Turn, Tip, Roll, Flip, Duplicate, Paste, Grid and
Shadows act once per press.

### Escape order

Each `Esc` press is handled by one owner, topmost first: an open dialog, dropdown or
filter popup; then the case selection; then an open mobile panel. In a search field,
`Esc` clears the search.

### Navigation

- **Left Mouse Drag** - Rotate camera (orbit)
- **Right Mouse Drag** - Pan camera
- **Mouse Wheel** - Zoom in/out
- **Click Case** - Select/deselect
- **Shift + Click** - Multi-select

## Usage

### Creating a Pack

1. Navigate to the **Packs** screen
2. Click **New Pack** button
3. Fill in pack details:
   - Title (required)
   - Client name (optional)
   - Project name (optional)
   - Drawn by (optional)
4. Choose truck dimensions or select from presets
5. Click **Create Pack**

### Managing Cases

1. Go to **Cases** from the sidebar
2. Click **New Case** to add equipment
3. Define case properties:
   - Name
   - Dimensions (Length × Width × Height in inches)
   - Color (for visual identification)
   - Weight (optional)
4. Cases appear in the Editor sidebar when packing

### Packing in 3D Editor

1. Open a pack from the **Packs** screen
2. In the Editor:
   - Drag cases from the left sidebar onto the truck bed
   - Click and drag cases to reposition them
   - Use mouse controls to orbit/zoom the camera
   - Select cases to see dimensions and properties
3. Use **Auto Pack** for automatic space optimization

### Exporting

**Export Full App**:

- Click **Export** in the topbar to download complete app state as JSON
- Includes all packs, cases, and preferences

**Export Single Pack**:

- Open pack's menu (three vertical dots)
- Select **Export JSON**
- Share the file with others

**Export to PDF/Excel**:

- In Editor, click **Export PDF** or **Export Excel**
- Generates professional reports with pack details and case lists

### Importing

**Import App Backup**:

- Click **Import** in topbar
- Select a previously exported app JSON file
- App state will be restored

**Import Pack**:

- On Packs screen, click **Import Pack**
- Select a pack JSON file (from someone else or backup)
- Pack will be added to your library

## Technical Details

- **Framework**: Vanilla JavaScript (ES6+)
- **3D Engine**: Three.js r185 / `0.185.1`, installed from npm
- **Development and Build Tool**: Vite `8.2.0`
- **Type Checking**: `typescript` is kept as a dev tool to run `npm run typecheck` (`tsc` with
  `--allowJs --checkJs`) against JavaScript sources
- **Production Format**: Static HTML, CSS, JavaScript, and application-owned bundled assets
- **Storage**: Browser localStorage with JSON export/import
- **Browser Requirements**: Modern browser with WebGL 2 support

## File Structure

```
truck-packer-3d/
├── index.html          # Static application shell and boot contract
├── src/                # Application modules
├── styles/             # Application styles
├── tests/              # Automated contract and behavior checks
├── vite.config.js      # Development, preview, and static build configuration
└── README.md           # This file
```

## Tips & Best Practices

1. **Save Often**: Use Export to create backups before major changes
2. **Case Library**: Build your case library first before creating packs
3. **Colors**: Use distinct colors for different case types for easy visual identification
4. **Auto-Pack**: Try auto-pack first, then manually adjust as needed
5. **Search**: Use search on Packs screen to quickly find projects (press Esc to clear)
6. **Theme**: Toggle theme from sidebar bottom for comfortable viewing
7. **Safe Imports**: Imports and backups are sanitized to drop `__proto__`/`constructor`/`prototype`
   keys; malformed JSON shows a toast instead of breaking the app

## Browser Compatibility

- ✅ Chrome 90+ (ES2020 support)
- ✅ Firefox 103+ (backdrop-filter support; 88-102 partial support)
- ✅ Safari 15+ (WebGL 2 support)
- ✅ Edge 90+ (ES2020 support)

**Note**: Requires WebGL 2 and ES2020 features including optional chaining (`?.`) and nullish
coalescing (`??`).

## Help

Click the **Help** button in the topbar for quick reference on Export/Import features.

## Security & Performance

- **Three.js/OrbitControls via npm**: Vite bundles both from the same pinned `three@0.185.1`
  package; the temporary `window.THREE` contract remains available and app init still waits for
  Three.js readiness.
- **Sanitized JSON**: All imports and localStorage loads strip dangerous keys (`__proto__`,
  `prototype`, `constructor`) to reduce prototype pollution risk.
- **Safe Rendering**: User/imported text now uses `textContent` instead of `innerHTML` in dialogs
  and headers.

## License

MIT License - Feel free to customize and use for your projects.

## Credits

Built with:

- [Three.js](https://threejs.org/) - 3D graphics library
- [Font Awesome](https://fontawesome.com/) - Icons
- [jsPDF](https://github.com/parallax/jsPDF) - PDF generation
- [SheetJS](https://sheetjs.com/) - Excel export

---

**Version**: 1.0.0  
**Author**: 360 Virtual Tour Solutions  
**Last Updated**: November 2026

## Current Roadmap

See [`docs/product/TP3D-MASTER-TODO-V6.md`](docs/product/TP3D-MASTER-TODO-V6.md) for the active
operational status, approved execution queue, and next milestone.

## Recent Major Milestones (2026)

- **Project AI memory/retrieval infrastructure** — `tools/project-memory` CLI, Obsidian vault
  integration, and Graphify routing for scoped AI context retrieval.
- **Generic Space Utilization Engine** — capacity-only spatial analysis (occupied %, remaining
  space, density visualization); not a safety or compliance score.
- **Three.js r185.1 via npm/Vite** — Three.js migrated from vendor CDN to npm + Vite build
  pipeline; pinned at `three@0.185.1`.
- **Quantity Controls** — ecommerce-style Case Qty, atomic Undo/Redo, Load Plans qty surfaces.
- **Business Identity** — Case item codes, Load Plan numbers, customer references.
- **Billing/Platform Foundation** — server-side workspace limits, org security, slug integrity,
  normalized billing entitlement.
- **Editor camera and view controls** — named camera views, Perspective/Orthographic projection,
  optional Zoom controls (PRs #120–#124).
- **Measurements and Annotations** — persistent point-to-point Measurement Tool, Callouts, Arrows and
  freehand Drawing, with shared Undo/Redo (PRs #125–#129).
- **Folder Foundation Stage 1** — Folder security, workspace-scoped persistence, damaged-data
  recovery, and Undo/Redo corrections (PR #132).
