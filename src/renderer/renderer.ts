interface Entry {
  id: number;
  text: string;
  created_at: number;
  pinned: number;
}

interface ClipboardAPI {
  search(query: string): Promise<Entry[]>;
  selectEntry(id: number): Promise<void>;
  hidePopup(): void;
  onResetSearch(callback: () => void): void;
}

const api = (window as unknown as { clipboardAPI: ClipboardAPI }).clipboardAPI;

const searchInput = document.getElementById('search') as HTMLInputElement;
const listEl = document.getElementById('list') as HTMLUListElement;

let results: Entry[] = [];
// The query `results` came from — not read live from the input at render
// time, since typing can move on while a search is still in flight.
let resultsQuery = '';
let selectedIndex = 0;

// Chars (~60 fit in the popup's width) the match must end within to be shown
// from the line's start; past that, the line is shown from MATCH_LEAD_CHARS
// before the match with a leading '…'. Char-based rather than measured, since
// the popup is pre-warmed hidden and layout isn't dependable then.
const MATCH_VISIBLE_CHARS = 45;
const MATCH_LEAD_CHARS = 20;
const MAX_SHOWN_CHARS = 200;

// Shows one line of the entry: the first line containing the search query
// (so a match on line 3 isn't hidden behind an unrelated line 1), else the
// first non-empty line, split around the match for highlighting.
// `above`/`below` say whether other non-empty lines exist before/after it —
// blank lines don't count, so a single line copied with a trailing newline
// (common from terminals) isn't marked. Matching is case-insensitive like
// store.ts's SQLite LIKE.
function summarize(
  text: string,
  query: string,
): { before: string; match: string; after: string; above: boolean; below: boolean } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const q = query.trim().toLowerCase();
  const found = q ? lines.findIndex((line) => line.toLowerCase().includes(q)) : -1;
  const index = found === -1 ? 0 : found;
  const line = (lines[index] ?? '').replace(/\s+/g, ' ').trim();
  const above = index > 0;
  const below = index < lines.length - 1;

  // Searched in the collapsed line (what's displayed) so offsets line up; can
  // only miss here if the query itself contains runs of whitespace. A
  // case-insensitive regex rather than toLowerCase().indexOf(), since
  // lowercasing can change string length (e.g. 'İ') and shift the offsets.
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hit = q ? new RegExp(escaped, 'iu').exec(line) : null;
  const at = hit ? hit.index : -1;
  let from = 0;
  if (hit && at + hit[0].length > MATCH_VISIBLE_CHARS) {
    from = Math.max(0, at - MATCH_LEAD_CHARS);
    const space = line.indexOf(' ', from);
    if (space !== -1 && space < at) from = space + 1;
  }
  const prefix = from > 0 ? '…' : '';
  const matchEnd = hit ? at + hit[0].length : from;
  const cut = Math.max(from + MAX_SHOWN_CHARS, matchEnd);
  const suffix = line.length > cut ? '…' : '';
  const shown = line.slice(0, cut);

  if (at === -1) {
    return { before: prefix + shown.slice(from) + suffix, match: '', after: '', above, below };
  }
  return {
    before: prefix + shown.slice(from, at),
    match: shown.slice(at, matchEnd),
    after: shown.slice(matchEnd) + suffix,
    above,
    below,
  };
}

function render(): void {
  listEl.innerHTML = '';
  if (results.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No matching entries';
    listEl.appendChild(li);
    return;
  }
  results.forEach((entry, i) => {
    const li = document.createElement('li');
    const summary = summarize(entry.text, resultsQuery);
    if (summary.above) {
      const above = document.createElement('span');
      above.className = 'more-lines above';
      above.title = 'More lines above';
      above.textContent = '⤸';
      li.appendChild(above);
    }
    const textEl = document.createElement('span');
    textEl.className = 'entry-text';
    // Text nodes + textContent only: entry text is untrusted clipboard content.
    textEl.append(summary.before);
    if (summary.match) {
      const mark = document.createElement('mark');
      mark.textContent = summary.match;
      textEl.append(mark);
    }
    textEl.append(summary.after);
    li.appendChild(textEl);
    if (summary.below) {
      const more = document.createElement('span');
      more.className = 'more-lines';
      more.title = 'More lines below';
      more.textContent = '⤸';
      li.appendChild(more);
    }
    if (i === selectedIndex) li.classList.add('selected');
    li.addEventListener('mouseenter', () => highlight(i));
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      choose(i);
    });
    listEl.appendChild(li);
  });
}

function highlight(index: number): void {
  const prevEl = listEl.children[selectedIndex] as HTMLElement | undefined;
  prevEl?.classList.remove('selected');
  selectedIndex = index;
  const el = listEl.children[selectedIndex] as HTMLElement | undefined;
  el?.classList.add('selected');
  el?.scrollIntoView({ block: 'nearest' });
}

async function refresh(): Promise<void> {
  const query = searchInput.value;
  results = await api.search(query);
  resultsQuery = query;
  selectedIndex = 0;
  render();
}

function choose(index: number): void {
  const entry = results[index];
  if (!entry) return;
  api.selectEntry(entry.id);
}

searchInput.addEventListener('input', () => {
  refresh();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (results.length > 0) highlight(Math.min(selectedIndex + 1, results.length - 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (results.length > 0) highlight(Math.max(selectedIndex - 1, 0));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    choose(selectedIndex);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    api.hidePopup();
  }
});

api.onResetSearch(() => {
  searchInput.value = '';
  searchInput.focus();
  refresh();
});

refresh();
