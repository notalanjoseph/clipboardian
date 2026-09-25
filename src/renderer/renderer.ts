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

// Shows one line of the entry: the first line containing the search query
// (so a match on line 3 isn't hidden behind an unrelated line 1), else the
// first non-empty line. `above`/`below` say whether other non-empty lines
// exist before/after it — blank lines don't count, so a single line copied
// with a trailing newline (common from terminals) isn't marked. Matching is
// case-insensitive like store.ts's SQLite LIKE.
function summarize(
  text: string,
  query: string,
): { text: string; above: boolean; below: boolean } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const q = query.trim().toLowerCase();
  const found = q ? lines.findIndex((line) => line.toLowerCase().includes(q)) : -1;
  const index = found === -1 ? 0 : found;
  const line = (lines[index] ?? '').replace(/\s+/g, ' ').trim();
  return {
    text: line.length > 200 ? line.slice(0, 200) + '…' : line,
    above: index > 0,
    below: index < lines.length - 1,
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
    textEl.textContent = summary.text;
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
