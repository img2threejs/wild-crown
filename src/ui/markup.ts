/** HTML escaping for every string the UI interpolates into markup. */
export const esc = (s: string | number | null | undefined): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const clamp = (n: number): number => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

/** "greenwake-pre-boar" → "Greenwake pre boar": checkpoint ids are authored slugs; this is their player-facing name. */
export function checkpointLabel(checkpointId: string | null | undefined): string | null {
    if (!checkpointId) return null;
    const words = checkpointId.replace(/[-_:]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

/** A `wc-action` button whose focus key is derived from its action and visible label, so focus survives re-renders. */
export function button(label: string, action: string, attrs = '', variant = ''): string {
    const focusKey = `${action}-${label.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()}`;
    return `<button type="button" class="wc-action ${variant}" data-ui-action="${esc(action)}" data-focus-key="${esc(focusKey)}" ${attrs}>${label}</button>`;
}
