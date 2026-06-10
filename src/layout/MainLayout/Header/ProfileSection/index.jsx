import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import ClickAwayListener from '@mui/material/ClickAwayListener';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Popper from '@mui/material/Popper';
import Stack from '@mui/material/Stack';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';

import useAuth from 'hooks/useAuth';
import useConfig from 'hooks/useConfig';
import MainCard from 'ui-component/cards/MainCard';
import Transitions from 'ui-component/extended/Transitions';

import { IconChecklist, IconLayoutList, IconLogout, IconSettings, IconSpeakerphone, IconUser, IconUsersGroup } from '@tabler/icons-react';
import Favicon from '/favicon.svg';

const NAV_ITEMS = [
  { key: 'hub', path: '/client-hub', label: 'Client Hub', icon: IconUsersGroup, roles: ['superadmin', 'admin', 'team'] },
  { key: 'tasks', path: '/tasks', label: 'Task Manager', icon: IconChecklist, roles: ['superadmin', 'admin', 'team'] },
  { key: 'ctm-forms', path: '/ctm-forms', label: 'CTM Forms', icon: IconLayoutList, roles: ['superadmin', 'admin'] },
  { key: 'portal-updates', path: '/portal-updates', label: 'Portal Updates', icon: IconSpeakerphone, roles: ['superadmin', 'admin'] }
];

const ROLE_LABELS = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member'
};

export default function ProfileSection() {
  const theme = useTheme();
  const {
    state: { borderRadius }
  } = useConfig();
  const { user, logout, actingClientId, selectedClientAccountId, setClientAccount, activeClientAccount } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [accountsAnchorEl, setAccountsAnchorEl] = useState(null);

  const anchorRef = useRef(null);
  const prevOpen = useRef(open);

  const accountOptions = user?.availableClientAccounts || [];
  const showAccountsMenu = !actingClientId && accountOptions.length > 1;
  const activeAccountId = selectedClientAccountId || user?.activeClientAccountId || null;

  const closeAccountsMenu = () => setAccountsOpen(false);

  const closeMenus = () => {
    setOpen(false);
    setAccountsOpen(false);
  };

  const handleToggle = () => {
    setOpen((prevOpenState) => !prevOpenState);
  };

  const handleClose = (event) => {
    if (anchorRef.current && anchorRef.current.contains(event.target)) {
      return;
    }

    closeMenus();
  };

  const handleAccountSelect = (clientOwnerId) => {
    setClientAccount(clientOwnerId);
    closeMenus();
    navigate('/portal');
  };

  useEffect(() => {
    if (prevOpen.current === true && open === false) {
      anchorRef.current?.focus();
    }

    if (!open) {
      setAccountsOpen(false);
    }

    prevOpen.current = open;
  }, [open]);

  return (
    <>
      <Chip
        slotProps={{ label: { sx: { lineHeight: 0 } } }}
        sx={{ ml: 2, height: '48px', alignItems: 'center', borderRadius: '27px' }}
        icon={
          <Avatar
            src={user?.avatar_url || Favicon}
            alt="user-images"
            sx={{ typography: 'mediumAvatar', margin: '8px 0 8px 8px !important', cursor: 'pointer' }}
            ref={anchorRef}
            aria-controls={open ? 'menu-list-grow' : undefined}
            aria-haspopup="true"
            color="inherit"
          />
        }
        label={<IconSettings stroke={1.5} size="24px" />}
        ref={anchorRef}
        aria-controls={open ? 'menu-list-grow' : undefined}
        aria-haspopup="true"
        onClick={handleToggle}
        color="primary"
        aria-label="user-account"
      />
      <Popper
        placement="bottom"
        open={open}
        anchorEl={anchorRef.current}
        transition
        disablePortal
        modifiers={[
          {
            name: 'offset',
            options: {
              offset: [0, 14]
            }
          }
        ]}
      >
        {({ TransitionProps }) => (
          <ClickAwayListener onClickAway={handleClose}>
            <Transitions in={open} {...TransitionProps}>
              <Paper>
                {open && (
                  <MainCard border={false} elevation={16} content={false} boxShadow shadow={theme.shadows[16]}>
                    <Box sx={{ p: 2, pb: 0 }}>
                      <Stack spacing={0.25}>
                        <Typography variant="h4">{user ? `${user.first_name} ${user.last_name}` : 'Profile'}</Typography>
                        <Typography variant="subtitle2">Anchor Dashboard</Typography>
                        {showAccountsMenu && activeClientAccount && (
                          <Typography variant="caption" color="text.secondary">
                            Viewing: {activeClientAccount.displayName}
                          </Typography>
                        )}
                      </Stack>
                    </Box>
                    <Box
                      sx={{
                        p: 2,
                        py: 0,
                        height: '100%',
                        maxHeight: 'calc(100vh - 250px)',
                        overflowX: 'hidden',
                        '&::-webkit-scrollbar': { width: 5 }
                      }}
                    >
                      <Divider />
                      <List
                        component="nav"
                        sx={{
                          width: '100%',
                          maxWidth: 350,
                          minWidth: 300,
                          borderRadius: `${borderRadius}px`,
                          '& .MuiListItemButton-root': { mt: 0.5 }
                        }}
                      >
                        {showAccountsMenu && (
                          <ListItemButton
                            onMouseEnter={(event) => {
                              setAccountsAnchorEl(event.currentTarget);
                              setAccountsOpen(true);
                            }}
                            sx={{ borderRadius: `${borderRadius}px` }}
                          >
                            <ListItemIcon>
                              <IconLayoutList stroke={1.5} size="20px" />
                            </ListItemIcon>
                            <ListItemText
                              primary={<Typography variant="body2">Accounts</Typography>}
                              secondary={activeClientAccount?.displayName || `${accountOptions.length} accounts`}
                            />
                            <ChevronRightIcon fontSize="small" color="action" />
                          </ListItemButton>
                        )}
                        {(() => {
                          const role = user?.effectiveRole || user?.role;
                          return NAV_ITEMS.filter((item) => item.roles.includes(role) && !location.pathname.startsWith(item.path)).map(
                            (item) => (
                              <ListItemButton
                                key={item.key}
                                onClick={(event) => {
                                  closeAccountsMenu();
                                  navigate(item.path);
                                  handleClose(event);
                                }}
                                onMouseEnter={closeAccountsMenu}
                                sx={{ borderRadius: `${borderRadius}px` }}
                              >
                                <ListItemIcon>
                                  <item.icon stroke={1.5} size="20px" />
                                </ListItemIcon>
                                <ListItemText primary={<Typography variant="body2">{item.label}</Typography>} />
                              </ListItemButton>
                            )
                          );
                        })()}
                        <ListItemButton
                          sx={{ borderRadius: `${borderRadius}px` }}
                          onClick={(event) => {
                            closeAccountsMenu();
                            navigate('/portal?tab=profile');
                            handleClose(event);
                          }}
                          onMouseEnter={closeAccountsMenu}
                        >
                          <ListItemIcon>
                            <IconSettings stroke={1.5} size="20px" />
                          </ListItemIcon>
                          <ListItemText primary={<Typography variant="body2">Profile Settings</Typography>} />
                        </ListItemButton>
                        <ListItemButton sx={{ borderRadius: `${borderRadius}px` }} onMouseEnter={closeAccountsMenu}>
                          <ListItemIcon>
                            <IconUser stroke={1.5} size="20px" />
                          </ListItemIcon>
                          <ListItemText
                            primary={
                              <Stack direction="column" sx={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
                                <Typography sx={{ fontWeight: 'bold' }} variant="body2">
                                  {user ? `${user.first_name} ${user.last_name}` : 'Profile'}
                                </Typography>
                                <Chip
                                  slotProps={{
                                    label: { sx: { mt: 0.25 } }
                                  }}
                                  sx={{ fontSize: '10px' }}
                                  label={user?.email || ''}
                                  variant="filled"
                                  size="small"
                                  color="warning"
                                />
                              </Stack>
                            }
                          />
                        </ListItemButton>
                        <ListItemButton
                          onClick={() => {
                            closeAccountsMenu();
                            logout().finally(() => handleClose({ target: null }));
                          }}
                          onMouseEnter={closeAccountsMenu}
                          sx={{ borderRadius: `${borderRadius}px` }}
                        >
                          <ListItemIcon>
                            <IconLogout stroke={1.5} size="20px" />
                          </ListItemIcon>
                          <ListItemText primary={<Typography variant="body2">Logout</Typography>} />
                        </ListItemButton>
                      </List>
                    </Box>
                  </MainCard>
                )}
              </Paper>
            </Transitions>
          </ClickAwayListener>
        )}
      </Popper>
      <Popper
        open={open && accountsOpen && Boolean(accountsAnchorEl)}
        anchorEl={accountsAnchorEl}
        placement="left-start"
        disablePortal
        modifiers={[
          {
            name: 'offset',
            options: {
              offset: [-8, 0]
            }
          }
        ]}
      >
        <Paper onMouseEnter={() => setAccountsOpen(true)} onMouseLeave={closeAccountsMenu} elevation={12}>
          <List sx={{ minWidth: 280, py: 1 }}>
            {accountOptions.map((account) => {
              const secondaryParts = [ROLE_LABELS[account.membershipRole] || account.membershipRole];
              if (account.businessName && account.ownerName) {
                secondaryParts.push(account.ownerName);
              } else if (account.ownerEmail && account.ownerEmail !== account.displayName) {
                secondaryParts.push(account.ownerEmail);
              }

              return (
                <ListItemButton
                  key={account.clientOwnerId}
                  selected={account.clientOwnerId === activeAccountId}
                  onClick={() => handleAccountSelect(account.clientOwnerId)}
                  sx={{ gap: 1.5, alignItems: 'flex-start' }}
                >
                  <ListItemText
                    primary={<Typography variant="body2">{account.displayName}</Typography>}
                    secondary={secondaryParts.join(' • ')}
                  />
                  {account.clientOwnerId === activeAccountId && <Chip label="Current" size="small" color="primary" />}
                </ListItemButton>
              );
            })}
          </List>
        </Paper>
      </Popper>
    </>
  );
}
