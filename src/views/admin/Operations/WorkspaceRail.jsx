import { List, ListItemButton, ListItemIcon, ListItemText, Box } from '@mui/material';
import HomeIcon from '@mui/icons-material/Home';
import GroupsIcon from '@mui/icons-material/Groups';
import GridViewIcon from '@mui/icons-material/GridView';
import { useOpsWorkspace } from './OpsWorkspaceContext';

const ITEMS = [
  { value: 'home', label: 'Home', Icon: HomeIcon },
  { value: 'clients', label: 'Clients', Icon: GroupsIcon },
  { value: 'portfolio', label: 'Portfolio', Icon: GridViewIcon }
];

export default function WorkspaceRail() {
  const { view, setView } = useOpsWorkspace();
  return (
    <Box sx={{ width: 180, borderRight: 1, borderColor: 'divider', flexShrink: 0 }}>
      <List dense disablePadding>
        {ITEMS.map(({ value, label, Icon }) => (
          <ListItemButton key={value} selected={view === value} onClick={() => setView(value)}>
            <ListItemIcon sx={{ minWidth: 36 }}>
              <Icon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={label} />
          </ListItemButton>
        ))}
      </List>
    </Box>
  );
}
