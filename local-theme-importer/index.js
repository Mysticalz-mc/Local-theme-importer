(function () {
'use strict';
const api = vendetta;
const React = api.metro.common.React;
const RN = api.metro.common.ReactNative;
const PREFIX = 'local-theme://importer/';
const MAX = 1024 * 1024;
let alive = false, undo, refreshTimer, appStateSubscription;
function object(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function color(x) {
    if (x === false || x === null) return x;
    if (typeof x !== 'string') throw new Error('Colors must be strings, false, or null.');
    const chroma = api.metro.common.chroma;
    if (!chroma || !chroma.valid(x)) throw new Error('Invalid color: ' + x);
    // Kettu performs normalization itself; retain alpha in hex/RGBA input.
    return x;
}
function parse(text) {
    if (typeof text !== 'string' || text.length > MAX) throw new Error('Theme must be smaller than 1 MiB.');
    let t;
    try { t = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (_) { throw new Error('This is not valid JSON.'); }
    if (!object(t) || typeof t.name !== 'string' || !t.name.trim()) throw new Error('Theme needs a name.');
    if (t.spec !== undefined && t.spec !== 2) throw new Error('This version supports Vendetta/Kettu spec 2 themes only.');
    if (!object(t.rawColors) && !object(t.semanticColors)) throw new Error('Theme needs rawColors or semanticColors.');
    // Whitelist supported declarative fields; theme files are never evaluated as code.
    const data = { name: t.name.trim().slice(0, 120), spec: 2 };
    if (typeof t.version === 'string' || typeof t.version === 'number') data.version = t.version;
    if (typeof t.description === 'string') data.description = t.description.slice(0, 2000);
    if (Array.isArray(t.authors)) data.authors = t.authors.filter(object).filter(a => typeof a.name === 'string').map(a => ({ name: a.name.slice(0, 120), ...(typeof a.id === 'string' ? { id: a.id } : {}) }));
    for (const field of ['rawColors', 'semanticColors']) {
        if (!object(t[field])) continue;
        data[field] = {};
        for (const key of Object.keys(t[field])) {
            if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Invalid color key: ' + key);
            const value = t[field][key];
            if (field === 'semanticColors') {
                if (!Array.isArray(value) || !value.length || value.length > 3) throw new Error('Semantic color ' + key + ' needs an array of 1–3 colors.');
                data[field][key] = value.map(color);
            } else {
                if (typeof value !== 'string') throw new Error('Raw color ' + key + ' needs a color string.');
                data[field][key] = color(value);
            }
        }
    }
    if (!Object.keys(data.rawColors || {}).length && !Object.keys(data.semanticColors || {}).length) throw new Error('No colors found.');
    if (t.background !== undefined) {
        if (!object(t.background) || typeof t.background.url !== 'string' || !/^https:\/\//i.test(t.background.url)) throw new Error('Background must use an HTTPS image URL.');
        data.background = { url: t.background.url };
        if (t.background.alpha !== undefined) {
            if (typeof t.background.alpha !== 'number' || t.background.alpha < 0 || t.background.alpha > 1) throw new Error('Background alpha must be between 0 and 1.');
            data.background.alpha = t.background.alpha;
        }
        for (const field of ['size', 'position']) {
            if (typeof t.background[field] === 'string') data.background[field] = t.background[field];
        }
    }
    if (t.plus !== undefined) {
        if (!object(t.plus) || t.plus.version !== 0) throw new Error('Themes+ data must use version 0.');
        data.plus = { version: 0 };
        if (t.plus.customOverlays !== undefined) {
            if (typeof t.plus.customOverlays !== 'boolean') throw new Error('customOverlays must be a boolean.');
            data.plus.customOverlays = t.plus.customOverlays;
        }
        if (t.plus.iconpack !== undefined) {
            if (typeof t.plus.iconpack !== 'string') throw new Error('iconpack must be a string.');
            data.plus.iconpack = t.plus.iconpack;
        }
        const plusColor = value => {
            const valid = x => typeof x === 'string' && (/^(SC_|RC_)[A-Z][A-Z0-9_]*$/.test(x) || /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(x));
            if (valid(value)) return value;
            if (Array.isArray(value) && value.length >= 1 && value.length <= 4 && value.every((x, i) => valid(x) || (i > 0 && x === null))) return value.slice();
            throw new Error('Invalid Themes+ color reference.');
        };
        if (t.plus.mentionLineColor !== undefined) data.plus.mentionLineColor = plusColor(t.plus.mentionLineColor);
        if (t.plus.icons !== undefined) {
            if (!object(t.plus.icons)) throw new Error('Themes+ icons must be an object.');
            data.plus.icons = Object.create(null);
            for (const [key, value] of Object.entries(t.plus.icons)) {
                if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid icon key.');
                data.plus.icons[key] = plusColor(value);
            }
        }
    }
    return data;
}
async function ready() {
    if (!api.themes || !api.themes.themes || !api.themes.selectTheme) throw new Error('Kettu theme API unavailable.');
    if (api.storage.awaitSyncWrapper) await api.storage.awaitSyncWrapper(api.themes.themes);
}
async function importText(text) {
    const data = parse(text);
    await ready();
    if (!alive) throw new Error('Enable Local Theme Importer first.');
    const id = PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    api.themes.themes[id] = { id, selected: false, data };
    try { await api.themes.fetchTheme(id, false); }
    catch (e) { delete api.themes.themes[id]; throw e; }
    return data.name;
}
async function applyTheme(id) {
    await ready();
    const theme = api.themes.themes[id];
    if (!theme || !object(theme.data)) throw new Error('Imported theme was not found. Import it again.');
    // The vendetta compatibility API accepts an ID and resolves the internal object.
    await api.themes.selectTheme(theme.id);
}
function scheduleSelectedThemeRefresh(delay) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
        refreshTimer = undefined;
        if (!alive) return;
        try {
            await ready();
            if (!alive) return;
            const theme = Object.values(api.themes.themes).find(t => t.selected && typeof t.id === 'string' && t.id.startsWith(PREFIX));
            if (theme && theme.data) await api.themes.selectTheme(theme.id);
        } catch (e) { console.warn('[Local Theme Importer] Could not refresh selected theme:', e); }
    }, delay);
}
function nativeFiles() {
    for (const name of ['NativeFileModule', 'RTNFileManager', 'DCDFileManager']) {
        let m;
        try { m = globalThis.__turboModuleProxy && globalThis.__turboModuleProxy(name); } catch (_) {}
        m = m || (globalThis.nativeModuleProxy && globalThis.nativeModuleProxy[name]) || (RN.NativeModules && RN.NativeModules[name]);
        if (m && typeof m.readFile === 'function') return m;
    }
    throw new Error('File reader unavailable. Use Paste JSON below.');
}
async function pickText() {
    const old = api.metro.findByProps('pickSingle', 'isCancel');
    const modern = api.metro.findByProps('pick', 'saveDocuments');
    if (!old && !modern) throw new Error('File picker unavailable. Use Paste JSON below.');
    const files = nativeFiles();
    let item, uri;
    try {
        if (old) {
            item = await old.pickSingle({ type: [old.types.allFiles], mode: 'import', copyTo: 'cachesDirectory' });
            uri = item.fileCopyUri;
            if (!uri) throw new Error(item.copyError || 'Could not copy selected file.');
        } else {
            item = (await modern.pick({ type: ['*/*'], mode: 'import', allowMultiSelection: false }))[0];
            if (!item) return null;
            if (item.error) throw new Error(item.error);
            if (item.size > MAX) throw new Error('Theme must be smaller than 1 MiB.');
            const copy = (await modern.keepLocalCopy({ files: [{ uri: item.uri, fileName: 'theme-import-' + Date.now() + '.json' }], destination: 'cachesDirectory' }))[0];
            if (copy.status !== 'success') throw new Error(copy.copyError || 'Could not copy selected file.');
            uri = copy.localUri;
        }
        if (item.size > MAX) throw new Error('Theme must be smaller than 1 MiB.');
        if (!/^file:\/\//.test(uri)) throw new Error('Could not read a local copy. Use Paste JSON.');
        return await files.readFile(decodeURIComponent(uri.replace(/^file:\/\//, '')), 'utf8');
    } catch (e) {
        if ((old && old.isCancel(e)) || ['OPERATION_CANCELED', 'DOCUMENT_PICKER_CANCELED'].includes(e.code)) return null;
        throw e;
    }
}
function Settings() {
    const [text, setText] = React.useState('');
    const [message, setMessage] = React.useState('Import a file, then apply it from the list below.');
    const [busy, setBusy] = React.useState(false);
    const [, refresh] = React.useState(0);
    const mounted = React.useRef(true), working = React.useRef(false);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    async function run(fn) {
        if (working.current) return;
        working.current = true; setBusy(true);
        try { const result = await fn(); if (mounted.current && result) setMessage(result); }
        catch (e) { if (mounted.current) setMessage(e.message || String(e)); }
        finally { working.current = false; if (mounted.current) { setBusy(false); refresh(v => v + 1); } }
    }
    const h = React.createElement;
    const label = (s, style) => h(RN.Text, { style: Object.assign({ color: '#f0eaff', marginBottom: 12, fontSize: 15 }, style) }, s);
    const button = (s, fn) => h(RN.Pressable, { disabled: busy, onPress: () => run(fn), style: { backgroundColor: '#58388a', padding: 13, borderRadius: 10, marginBottom: 10, opacity: busy ? 0.5 : 1 } }, label(s, { marginBottom: 0 }));
    const list = Object.values(api.themes.themes).filter(t => t.id && t.id.startsWith(PREFIX));
    return h(RN.ScrollView, { style: { flex: 1, backgroundColor: '#19141f' }, contentContainerStyle: { padding: 18 } },
        label('Local Theme Importer', { fontSize: 23 }), label(message),
        button('Choose JSON file', async () => { const s = await pickText(); return s === null ? 'Import cancelled.' : 'Imported: ' + await importText(s); }),
        label('Or paste the contents of a theme JSON file:'),
        h(RN.TextInput, { value: text, onChangeText: setText, multiline: true, editable: !busy, placeholder: '{ "name": "My theme", ... }', placeholderTextColor: '#aaa0b9', autoCorrect: false, autoCapitalize: 'none', style: { minHeight: 130, maxHeight: 250, borderWidth: 1, borderColor: '#77608b', borderRadius: 8, padding: 12, color: '#fff', textAlignVertical: 'top', marginBottom: 12 } }),
        button('Import pasted JSON', async () => { const name = await importText(text); if (mounted.current) setText(''); return 'Imported: ' + name; }),
        label('Imported themes', { fontSize: 19 }),
        ...list.map(t => h(RN.View, { key: t.id, style: { marginBottom: 15 } }, label(t.data.name + (t.selected ? ' — active' : '')),
            button('Apply', async () => { await applyTheme(t.id); return 'Applied: ' + t.data.name + '. Restart Discord to refresh all colors.'; }),
            button('Delete', () => new Promise((resolve, reject) => RN.Alert.alert('Delete theme?', t.data.name, [
                { text: 'Cancel', style: 'cancel', onPress: () => resolve('Deletion cancelled.') },
                { text: 'Delete', style: 'destructive', onPress: () => Promise.resolve(api.themes.removeTheme(t.id)).then(() => resolve('Theme deleted.')).catch(reject) }
            ], { cancelable: false }))))),
        label('Spec 2 Kettu/Vendetta themes only. Background URLs may load images from the internet. Imported themes are stored locally; restart Discord after applying.'));
}
return {
    onLoad: function () {
        if (alive) return;
        if (!api.themes || !api.themes.themes) throw new Error('Kettu themes are unavailable.');
        alive = true;
        // Only intercept our local IDs. Normal theme downloads and all other requests pass through.
        undo = api.patcher.instead('fetch', globalThis, function (args, original) {
            const input = args[0];
            const id = typeof input === 'string' ? input : input && input.url;
            if (typeof id === 'string' && id.startsWith(PREFIX)) {
                const entry = api.themes.themes[id];
                if (!entry) return Promise.reject(new Error('Local theme was deleted.'));
                return Promise.resolve(new Response(JSON.stringify(entry.data), { status: 200, headers: { 'Content-Type': 'application/json' } }));
            }
            return original.apply(globalThis, args);
        });
        // Kettu can restore the saved theme before chat and the importer finish loading.
        // A second selection refreshes chat colors without changing any other theme.
        scheduleSelectedThemeRefresh(2000);
        if (RN.AppState && typeof RN.AppState.addEventListener === 'function') {
            appStateSubscription = RN.AppState.addEventListener('change', state => {
                if (state === 'active' && alive) scheduleSelectedThemeRefresh(750);
            });
        }
    },
    onUnload: function () {
        alive = false;
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = undefined;
        if (appStateSubscription && appStateSubscription.remove) appStateSubscription.remove();
        appStateSubscription = undefined;
        if (undo) undo();
        undo = undefined;
    },
    settings: Settings
};
})();
