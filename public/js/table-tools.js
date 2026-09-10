/*
 * table-tools.js — quick filter + column sorting + pagination for one table.
 *
 * Usage on a page:
 *   <script src="/js/table-tools.js"></script>
 *   <script>initTableTools('dashboardTable', { pageSize: 50 });</script>
 */
(function () {
  'use strict';

  window.initTableTools = function (tableId, options) {
    var opts = Object.assign(
      { pageSize: 50, filterId: 'quickFilter', emptyId: 'noResultsMsg' },
      options || {}
    );

    var table = document.getElementById(tableId);
    if (!table) return;

    var tbody = table.querySelector('tbody');
    if (!tbody) return;

    var filterInput = document.getElementById(opts.filterId);
    var emptyMsg = document.getElementById(opts.emptyId);

    var allRows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
    var matchedRows = allRows.slice();
    var page = 1;

    var pager = document.createElement('div');
    pager.className = 'table-pager';
    table.insertAdjacentElement('afterend', pager);

    /* ---------- filtering ---------- */

    function applyFilter(resetPage) {
      var q = filterInput ? filterInput.value.trim().toLowerCase() : '';
      matchedRows = q
        ? allRows.filter(function (row) {
            return row.textContent.toLowerCase().indexOf(q) !== -1;
          })
        : allRows.slice();

      if (resetPage !== false) page = 1;
      render();
    }

    if (filterInput) {
      filterInput.addEventListener('input', function () {
        applyFilter(true);
      });
    }

    /* ---------- rendering the current page ---------- */

    function render() {
      var total = matchedRows.length;
      var pageCount = Math.max(1, Math.ceil(total / opts.pageSize));
      if (page > pageCount) page = pageCount;
      if (page < 1) page = 1;

      var start = (page - 1) * opts.pageSize;
      var end = Math.min(start + opts.pageSize, total);

      allRows.forEach(function (row) {
        row.style.display = 'none';
      });
      matchedRows.slice(start, end).forEach(function (row) {
        row.style.display = '';
      });

      table.style.display = total === 0 ? 'none' : '';
      if (emptyMsg) emptyMsg.style.display = total === 0 ? 'block' : 'none';

      drawPager(total, pageCount, start, end);
    }

    function drawPager(total, pageCount, start, end) {
      pager.innerHTML = '';
      if (total === 0) return;

      var info = document.createElement('span');
      info.className = 'pager-info';
      info.textContent = 'Showing ' + (start + 1) + '–' + end + ' of ' + total;
      pager.appendChild(info);

      if (pageCount <= 1) return;

      var nav = document.createElement('div');
      nav.className = 'pager-buttons';

      function addButton(label, targetPage, disabled, isCurrent) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pager-btn' + (isCurrent ? ' active' : '');
        btn.textContent = label;
        btn.disabled = !!disabled;
        btn.addEventListener('click', function () {
          page = targetPage;
          render();
          table.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        nav.appendChild(btn);
      }

      function addGap() {
        var gap = document.createElement('span');
        gap.className = 'pager-gap';
        gap.textContent = '…';
        nav.appendChild(gap);
      }

      addButton('‹ Prev', page - 1, page === 1, false);

      var span = 2;
      var from = Math.max(1, page - span);
      var to = Math.min(pageCount, page + span);

      if (from > 1) {
        addButton('1', 1, false, page === 1);
        if (from > 2) addGap();
      }
      for (var p = from; p <= to; p++) {
        addButton(String(p), p, false, p === page);
      }
      if (to < pageCount) {
        if (to < pageCount - 1) addGap();
        addButton(String(pageCount), pageCount, false, page === pageCount);
      }

      addButton('Next ›', page + 1, page === pageCount, false);

      pager.appendChild(nav);
    }

    /* ---------- column sorting ---------- */

    var headers = table.querySelectorAll('th[data-sort]');

    headers.forEach(function (th, colIndex) {
      th.style.cursor = 'pointer';
      var ascending = true;

      th.addEventListener('click', function () {
        var type = th.dataset.sort;

        allRows.sort(function (a, b) {
          var cellA = a.children[colIndex];
          var cellB = b.children[colIndex];
          if (!cellA || !cellB) return 0;

          var valA = (cellA.dataset.sortValue !== undefined
            ? cellA.dataset.sortValue
            : cellA.textContent).trim();
          var valB = (cellB.dataset.sortValue !== undefined
            ? cellB.dataset.sortValue
            : cellB.textContent).trim();

          var cmp;
          if (type === 'date') {
            // Empty dates always sort to the end, regardless of direction
            if (!valA && !valB) cmp = 0;
            else if (!valA) return 1;
            else if (!valB) return -1;
            else cmp = new Date(valA) - new Date(valB);
          } else {
            cmp = valA.localeCompare(valB, undefined, { sensitivity: 'base' });
          }
          return ascending ? cmp : -cmp;
        });

        allRows.forEach(function (row) {
          tbody.appendChild(row);
        });

        ascending = !ascending;
        applyFilter(false); // keep the user on the same page number
      });
    });

    /* ---------- first paint ---------- */
    applyFilter(true);
  };
})();