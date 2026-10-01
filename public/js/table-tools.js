/**
 * Shared filter + sort + pagination for the app's data tables.
 *
 * The three behaviours have to share state: pagination slices the FILTERED
 * rows, not all of them, or filtering to 3 rows would still say "page 4 of 9".
 * Sorting reorders the master list, then the filter and page slice are
 * recomputed from it.
 *
 * Usage:
 *   initDataTable({
 *     tableId: 'customersTable',
 *     filterId: 'quickFilter',      // optional
 *     emptyId: 'noResultsMsg',      // optional
 *     paginationId: 'tablePagination',
 *     pageInfoId: 'pageInfo',
 *     pageSize: 10,
 *   });
 *
 * Sorting reads th[data-sort] — "date", "number", or anything else for text —
 * and a cell's data-sort-value wins over its visible text when present.
 */
function initDataTable(options) {
  const table = document.getElementById(options.tableId);
  if (!table) return;

  const pageSize = options.pageSize || 10;
  const quickFilter = options.filterId ? document.getElementById(options.filterId) : null;
  const emptyMsg = options.emptyId ? document.getElementById(options.emptyId) : null;
  const paginationEl = options.paginationId ? document.getElementById(options.paginationId) : null;
  const pageInfoEl = options.pageInfoId ? document.getElementById(options.pageInfoId) : null;

  const tbody = table.querySelector('tbody');
  const allRows = Array.from(tbody.querySelectorAll('tr'));
  let filteredRows = allRows.slice();
  let currentPage = 1;

  function applyFilter() {
    const q = quickFilter ? quickFilter.value.trim().toLowerCase() : '';
    filteredRows = q
      ? allRows.filter((row) => row.textContent.toLowerCase().includes(q))
      : allRows.slice();
  }

  function render() {
    const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;

    // Hide everything, then show this page's slice. Simpler and less
    // error-prone than tracking which rows were visible last time.
    allRows.forEach((row) => { row.style.display = 'none'; });

    const start = (currentPage - 1) * pageSize;
    const pageRows = filteredRows.slice(start, start + pageSize);
    pageRows.forEach((row) => { row.style.display = ''; });

    const isEmpty = filteredRows.length === 0;
    table.style.display = isEmpty ? 'none' : '';
    if (emptyMsg) emptyMsg.style.display = isEmpty ? 'block' : 'none';

    if (pageInfoEl) {
      pageInfoEl.textContent = isEmpty
        ? ''
        : `Showing ${start + 1}–${start + pageRows.length} of ${filteredRows.length}`;
    }

    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    if (!paginationEl) return;
    paginationEl.innerHTML = '';

    // Follows Bootstrap's own pagination markup: active and disabled items use
    // <span> rather than <a>, so they can't be clicked or tabbed to.
    const addItem = (label, page, opts = {}) => {
      const li = document.createElement('li');
      li.className = 'page-item'
        + (opts.disabled ? ' disabled' : '')
        + (opts.active ? ' active' : '');

      if (opts.disabled || opts.active) {
        const span = document.createElement('span');
        span.className = 'page-link';
        span.textContent = label;

        if (opts.active) {
          const sr = document.createElement('span');
          sr.className = 'visually-hidden';
          sr.textContent = '(current)';
          span.appendChild(sr);
        }

        li.appendChild(span);
      } else {
        const a = document.createElement('a');
        a.className = 'page-link';
        a.href = '#';
        a.textContent = label;
        a.addEventListener('click', (e) => {
          e.preventDefault();
          currentPage = page;
          render();
          table.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        li.appendChild(a);
      }

      paginationEl.appendChild(li);
    };

    addItem('Previous', currentPage - 1, { disabled: currentPage === 1 });

    // First, last, and two either side of the current page. With 40 pages,
    // printing all 40 buttons would wrap onto three lines.
    let lastPrinted = 0;
    for (let p = 1; p <= totalPages; p++) {
      const nearCurrent = Math.abs(p - currentPage) <= 2;
      if (p !== 1 && p !== totalPages && !nearCurrent) continue;
      if (lastPrinted && p - lastPrinted > 1) addItem('…', 0, { disabled: true });
      addItem(String(p), p, { active: p === currentPage });
      lastPrinted = p;
    }

    addItem('Next', currentPage + 1, { disabled: currentPage === totalPages });
  }

  if (quickFilter) {
    quickFilter.addEventListener('input', () => {
      applyFilter();
      currentPage = 1;        // a new search always starts at the top
      render();
    });
  }

  table.querySelectorAll('th[data-sort]').forEach((th, colIndex) => {
    th.style.cursor = 'pointer';
    let ascending = true;

    th.addEventListener('click', () => {
      const type = th.dataset.sort;

      allRows.sort((a, b) => {
        const cellA = a.children[colIndex];
        const cellB = b.children[colIndex];
        const valA = (cellA.dataset.sortValue !== undefined ? cellA.dataset.sortValue : cellA.textContent).trim();
        const valB = (cellB.dataset.sortValue !== undefined ? cellB.dataset.sortValue : cellB.textContent).trim();

        let cmp;
        if (type === 'date') {
          // Empty dates always sort to the end, regardless of direction.
          if (!valA && !valB) cmp = 0;
          else if (!valA) cmp = 1;
          else if (!valB) cmp = -1;
          else cmp = new Date(valA) - new Date(valB);
        } else if (type === 'number') {
          cmp = (Number(valA) || 0) - (Number(valB) || 0);
        } else {
          cmp = valA.localeCompare(valB, undefined, { sensitivity: 'base' });
        }
        return ascending ? cmp : -cmp;
      });

      allRows.forEach((row) => tbody.appendChild(row));
      applyFilter();
      currentPage = 1;
      render();
      ascending = !ascending;
    });
  });

  render();
}
