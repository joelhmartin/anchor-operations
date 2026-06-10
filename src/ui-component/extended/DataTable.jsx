import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import TablePagination from '@mui/material/TablePagination';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import LinearProgress from '@mui/material/LinearProgress';
import SearchIcon from '@mui/icons-material/Search';
import EmptyState from './EmptyState';

/**
 * DataTable — declarative table with optional search, sort, pagination, and empty/loading states.
 *
 * Columns define the header label, cell rendering, sorting, and alignment.
 * All cell content is fully customizable via column `render` functions.
 *
 * @param {Array}  columns         – Column definitions (see below)
 * @param {Array}  rows            – Data rows
 * @param {string|function} [rowKey="id"] – Row key field name or `(row, index) => key`
 *
 * Column shape:
 *   { id, label, render?, align?, sortable?, sortValue?, width?, minWidth?, hidden? }
 *   - render(row, index): ReactNode — cell content (defaults to `row[id]`)
 *   - sortValue(row): comparable    — value used for sorting (defaults to `row[id]`)
 *   - hidden: boolean               — skip column entirely (useful for conditional columns)
 *
 * @param {object}  [defaultSort]          – { id, direction: 'asc'|'desc' }
 * @param {boolean} [searchable=false]     – Show search bar
 * @param {Array}   [searchFields]         – Fields/getters to search (defaults to all column ids)
 * @param {string}  [searchPlaceholder]    – Search input placeholder
 * @param {boolean} [paginated=false]      – Show pagination
 * @param {number}  [pageSize=10]          – Rows per page default
 * @param {Array}   [pageSizeOptions]      – Options for rows-per-page selector
 * @param {boolean} [loading=false]        – Show loading indicator
 * @param {string}  [emptyTitle]           – Empty state title
 * @param {string}  [emptyMessage]         – Empty state message
 * @param {ReactElement} [emptyIcon]       – Empty state icon
 * @param {ReactNode}    [emptyAction]     – Empty state action button
 * @param {string}  [size="small"]         – MUI Table size
 * @param {boolean} [outlined=false]       – Wrap in Paper variant="outlined"
 * @param {boolean} [stickyHeader=false]   – Sticky table header
 * @param {string|number} [maxHeight]      – Max height for scrollable table
 * @param {boolean} [hover=true]           – Highlight rows on hover
 * @param {function} [onRowClick]          – (row, index) => void
 * @param {object}  [sx]                   – Additional sx for the root Box
 */
export default function DataTable({
  columns,
  rows = [],
  rowKey = 'id',
  defaultSort,
  searchable = false,
  searchFields,
  searchPlaceholder = 'Search…',
  paginated = false,
  pageSize: defaultPageSize = 10,
  pageSizeOptions = [10, 25, 50],
  loading = false,
  emptyTitle = 'No data',
  emptyMessage,
  emptyIcon,
  emptyAction,
  size = 'small',
  outlined = false,
  stickyHeader = false,
  maxHeight,
  hover = true,
  onRowClick,
  sx,
}) {
  // Filter out hidden columns
  const visibleColumns = useMemo(
    () => (columns || []).filter((c) => !c.hidden),
    [columns]
  );

  // --- Search ---
  const [searchQuery, setSearchQuery] = useState('');

  const searchedRows = useMemo(() => {
    if (!searchable || !searchQuery.trim()) return rows;
    const q = searchQuery.trim().toLowerCase();
    const fields = searchFields || visibleColumns.map((c) => c.id);
    const getters = fields.map((f) =>
      typeof f === 'function' ? f : (row) => row?.[f]
    );
    return rows.filter((row) =>
      getters.some((g) => {
        const v = g(row);
        return v != null && String(v).toLowerCase().includes(q);
      })
    );
  }, [rows, searchable, searchQuery, searchFields, visibleColumns]);

  // --- Sort ---
  const [sortId, setSortId] = useState(defaultSort?.id || null);
  const [sortDir, setSortDir] = useState(defaultSort?.direction || 'asc');

  const handleSort = (colId) => {
    if (sortId === colId) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortId(colId);
      setSortDir('asc');
    }
  };

  const sortedRows = useMemo(() => {
    if (!sortId) return searchedRows;
    const col = visibleColumns.find((c) => c.id === sortId);
    if (!col) return searchedRows;
    const getValue = col.sortValue || ((row) => row?.[col.id]);
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...searchedRows].sort((a, b) => {
      const va = getValue(a);
      const vb = getValue(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
    });
  }, [searchedRows, sortId, sortDir, visibleColumns]);

  // --- Pagination ---
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(defaultPageSize);

  // Clamp page when filtered/sorted rows shrink below current page offset
  const maxPage = Math.max(0, Math.ceil(sortedRows.length / rowsPerPage) - 1);
  const safePage = Math.min(page, maxPage);
  if (safePage !== page) setPage(safePage);

  const displayRows = paginated
    ? sortedRows.slice(safePage * rowsPerPage, safePage * rowsPerPage + rowsPerPage)
    : sortedRows;

  const getKey = typeof rowKey === 'function' ? rowKey : (row, i) => row?.[rowKey] ?? i;

  const Wrapper = outlined ? Paper : Box;
  const wrapperProps = outlined ? { variant: 'outlined' } : {};

  return (
    <Box sx={sx}>
      {searchable && (
        <TextField
          size="small"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          sx={{ mb: 1.5, maxWidth: 320 }}
        />
      )}

      {loading && <LinearProgress sx={{ mb: 0.5 }} />}

      <TableContainer
        component={Wrapper}
        {...wrapperProps}
        sx={maxHeight ? { maxHeight } : undefined}
      >
        <Table size={size} stickyHeader={stickyHeader}>
          <TableHead>
            <TableRow>
              {visibleColumns.map((col) => (
                <TableCell
                  key={col.id}
                  align={col.align}
                  sx={{
                    ...(col.width ? { width: col.width } : {}),
                    ...(col.minWidth ? { minWidth: col.minWidth } : {}),
                  }}
                >
                  {col.sortable ? (
                    <TableSortLabel
                      active={sortId === col.id}
                      direction={sortId === col.id ? sortDir : 'asc'}
                      onClick={() => handleSort(col.id)}
                    >
                      {col.label}
                    </TableSortLabel>
                  ) : (
                    col.label
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {displayRows.length === 0 && !loading ? (
              <TableRow>
                <TableCell colSpan={visibleColumns.length} sx={{ border: 0 }}>
                  <EmptyState
                    title={emptyTitle}
                    message={emptyMessage}
                    icon={emptyIcon}
                    action={emptyAction}
                  />
                </TableCell>
              </TableRow>
            ) : (
              displayRows.map((row, i) => (
                <TableRow
                  key={getKey(row, i)}
                  hover={hover}
                  onClick={onRowClick ? () => onRowClick(row, i) : undefined}
                  sx={onRowClick ? { cursor: 'pointer' } : undefined}
                >
                  {visibleColumns.map((col) => (
                    <TableCell key={col.id} align={col.align}>
                      {col.render ? col.render(row, i) : row?.[col.id]}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {paginated && sortedRows.length > 0 && (
        <TablePagination
          component="div"
          count={sortedRows.length}
          page={page}
          onPageChange={(_, p) => setPage(p)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(e) => {
            setRowsPerPage(parseInt(e.target.value, 10));
            setPage(0);
          }}
          rowsPerPageOptions={pageSizeOptions}
        />
      )}
    </Box>
  );
}
