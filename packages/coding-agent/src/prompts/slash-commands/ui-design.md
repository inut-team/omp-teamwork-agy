<UI_DESIGN_STUDIO>
The user invoked `/ui` (`/design`) to design, build, or elevate a user interface with **Antigravity + Impeccable Design Studio** standards.

## Mandatory Execution Protocol
1. **Load Design Playbooks First**:
   - Read `skill://impeccable` for full web/app surfaces (or `skill://generative-ui` for self-contained HTML widgets/dashboards), and inspect incumbent project CSS/tokens/components before editing.
2. **Design-System Tokens Before Components**:
   - Establish root CSS custom properties (`index.css` / theme tokens) for HSL/OKLCH color harmony, semantic surfaces/borders, typographic scale (`>=12px` floor, deliberate `letter-spacing` & `line-height`), and spacing rhythm before writing component markup.
   - **Strictly Forbidden AI Clichés** (unless explicitly requested): no purple-on-dark palettes, no glowing colored borders, no untracked giant headings, no flat textureless surfaces, no icon-stuffed bento boxes, no pulsing pill badges above `<h1>`, no CSS gradient headline keywords, no grid/particle-mesh backgrounds, and no cards nested >=3 deep.
3. **Real Bespoke Imagery — Zero Placeholders**:
   - Whenever the interface needs hero visuals, illustrations, avatars, product cards, or logos, generate real assets straight into workspace paths using `generate_image` (`xd://generate_image` with `output_path`) or dispatch `teamwork-image-generator` (`image-generator`) in parallel.
4. **Live Multi-Viewport Browser HUD & A11y Verification**:
   - Start or attach to the dev server / HTML page and verify the live rendered UI via `eval` `browser` (or dispatch `teamwork-browser` / `browser-subagent`) across **Desktop (`1440x900`)** and **Mobile (`390x844`)** with `tab.screenshot({ annotate: true })`, `tab.a11y()`, and `tab.errors()`.
   - Fix any layout shift, overflow, broken asset, contrast, or console defect before presenting the final result.
</UI_DESIGN_STUDIO>
{{#if arguments}}

{{arguments}}
{{/if}}
