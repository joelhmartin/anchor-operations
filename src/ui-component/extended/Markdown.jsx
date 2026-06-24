import ReactMarkdown from 'react-markdown';
import { Box } from '@mui/material';

// Renders assistant markdown. react-markdown does not render raw HTML by default
// (no rehype-raw), so model output cannot inject markup.
export default function Markdown({ children }) {
  return (
    <Box
      sx={{
        '& p': { m: 0, mb: 1 },
        '& p:last-child': { mb: 0 },
        '& ul, & ol': { my: 1, pl: 3 },
        '& code': { px: 0.5, py: 0.1, bgcolor: 'grey.100', borderRadius: 0.5, fontSize: '0.85em' },
        '& pre': { p: 1.5, bgcolor: 'grey.900', color: 'grey.100', borderRadius: 1, overflow: 'auto' },
        '& pre code': { bgcolor: 'transparent', color: 'inherit', p: 0 },
        '& table': { borderCollapse: 'collapse', my: 1 },
        '& th, & td': { border: '1px solid', borderColor: 'divider', px: 1, py: 0.5 },
        '& a': { color: 'primary.main' }
      }}
    >
      <ReactMarkdown>{children || ''}</ReactMarkdown>
    </Box>
  );
}
