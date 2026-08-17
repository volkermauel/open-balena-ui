import { Box, Checkbox, ListItemText, MenuItem, Select, SelectChangeEvent, useTheme } from '@mui/material';
import IconButton from '@mui/material/IconButton';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import React from 'react';
import { useAuthProvider, useDataProvider, useRecordContext, useNotify } from 'react-admin';
import type { DataProvider } from 'react-admin';
import environment from '../lib/reactAppEnv';
import type { ResourceRecord } from '../types/resource';
import type { OpenBalenaAuthProvider, OpenBalenaSession } from '../authProvider/openbalenaAuthProvider';
import { EmbeddedFrame } from './EmbeddedFrame';

interface ContainerChoice {
  id: number;
  name: string;
}

interface LogEntry {
  timestamp: string;
  message: string;
  isStdErr?: boolean;
  isSystem?: boolean;
  serviceId?: number;
}

type DeviceRecord = ResourceRecord & {
  uuid: string;
};

// Live-tail polling. While tailing is enabled, at least one container is
// selected and the tab is visible, the api logs endpoint is polled once per
// interval and the pane scrolls to the newest entry (matching the official
// balena dashboard behaviour).
const LOGS_POLL_INTERVAL_MS = 1000;
// After a failed request, poll slower until one succeeds to avoid hammering the
// api (e.g. device offline, api restarting).
const LOGS_ERROR_POLL_INTERVAL_MS = 5000;

const HOST_CONTAINER_ID = 0;

export const DeviceLogs: React.FC = () => {
  const record = useRecordContext<DeviceRecord>();
  const [loaded, setLoaded] = React.useState(false);
  const [containers, setContainers] = React.useState<ContainerChoice[]>([]);
  const [selectedIds, setSelectedIds] = React.useState<number[]>([]);
  const [content, setContent] = React.useState('');
  const [tailing, setTailing] = React.useState(true);
  const [timestamps, setTimestamps] = React.useState(true);
  const dataProvider = useDataProvider<DataProvider>();
  const authProvider = useAuthProvider<OpenBalenaAuthProvider>();
  const notify = useNotify();
  const theme = useTheme();

  // Live-tail bookkeeping (refs: not part of the render path)
  const inFlightRef = React.useRef(false);
  const errorCountRef = React.useRef(0);
  const errorNotifiedRef = React.useRef(false);
  const lastAttemptRef = React.useRef(0);

  // Get logs colors from theme palette
  const logsPalette = theme.palette.logs;
  const logsBgColor = logsPalette?.background ?? (theme.palette.mode === 'dark' ? '#0d1a26' : '#343434');
  const logsTextColor = logsPalette?.text?.default ?? '#eeeeee';
  const logsErrorColor = logsPalette?.text?.error ?? '#ee6666';
  const logsWarningColor = logsPalette?.text?.warning ?? '#ffee66';

  const nameById = React.useMemo(() => new Map(containers.map((choice) => [choice.id, choice.name])), [containers]);

  const allSelected = containers.length > 0 && selectedIds.length === containers.length;

  // Generate empty shell HTML with proper background
  const emptyLogsHtml = React.useMemo(
    () =>
      `<html><body style='font-family: consolas; color: ${logsTextColor}; background-color: ${logsBgColor}; margin: 0; padding: 10px;'></body></html>`,
    [logsBgColor, logsTextColor],
  );

  // Use empty shell when no content
  const displayContent = content || emptyLogsHtml;

  const fetchLogs = React.useCallback(async (): Promise<LogEntry[]> => {
    if (!record) {
      throw new Error('Device record is not available');
    }

    const session: OpenBalenaSession | undefined = authProvider?.getSession?.();
    if (!session?.jwt) {
      throw new Error('Unable to fetch logs without a valid session');
    }

    const apiHost = environment.REACT_APP_OPEN_BALENA_API_URL;
    const response = await fetch(`${apiHost}/device/v2/${record.uuid}/logs`, {
      method: 'GET',
      headers: new Headers({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.jwt}`,
      }),
      insecureHTTPParser: true,
    });

    if (!response.ok) {
      throw new Error(response.statusText);
    }

    return (await response.json()) as LogEntry[];
  }, [authProvider, record]);

  const updateLogs = React.useCallback(async () => {
    if (selectedIds.length === 0 || inFlightRef.current) {
      return;
    }

    inFlightRef.current = true;
    lastAttemptRef.current = Date.now();

    try {
      const logs = await fetchLogs();
      errorCountRef.current = 0;
      errorNotifiedRef.current = false;

      if (!logs?.length) {
        setContent((previous) => (previous === '' ? previous : ''));
        return;
      }

      const selectedSet = new Set(selectedIds);
      const filteredLogs = logs.filter((entry) => {
        const entryServiceId =
          Object.prototype.hasOwnProperty.call(entry, 'serviceId') && entry.serviceId != null
            ? Number(entry.serviceId)
            : HOST_CONTAINER_ID;

        return selectedSet.has(entryServiceId);
      });

      let nextContent = '';
      if (filteredLogs.length) {
        // Only prefix lines with the container name when the view mixes more
        // than one container — single-container output stays clean.
        const prefixNames = selectedIds.length > 1;

        const formattedLogs = filteredLogs
          .map((entry) => {
            const time = timestamps ? `[${new Date(entry.timestamp).toISOString()}] ` : '';
            const name = prefixNames
              ? `[${
                  nameById.get(
                    Object.prototype.hasOwnProperty.call(entry, 'serviceId') && entry.serviceId != null
                      ? Number(entry.serviceId)
                      : HOST_CONTAINER_ID,
                  ) ?? 'unknown'
                }] `
              : '';
            const message = entry.message ?? '';

            if (entry.isStdErr) {
              return `${time}${name}<span style="color: ${logsErrorColor}; ">${message}</span>`;
            }

            if (entry.isSystem) {
              return `${time}${name}<span style="color: ${logsWarningColor}; ">${message}</span>`;
            }

            return `${time}${name}${message}`;
          })
          .join('<br/>');

        nextContent = `<html>
          <body style='font-family: consolas; color: ${logsTextColor}; background-color: ${logsBgColor}; margin: 0; padding: 10px;'>
            <div>${formattedLogs}</div>
            <script>window.scrollTo(0, document.body.scrollHeight);</script>
          </body>
        </html>`;
      }

      // Only replace the frame document when something actually changed: the
      // iframe fully reloads on every srcDoc change, so an unconditional update
      // would flicker once per poll while a device is idle.
      setContent((previous) => (previous === nextContent ? previous : nextContent));
    } catch (error) {
      console.error(error);
      errorCountRef.current += 1;
      // Notify once per outage instead of once per failed poll.
      if (record?.uuid && !errorNotifiedRef.current) {
        errorNotifiedRef.current = true;
        notify(`Error: Could not get logs for device ${record.uuid}`, { type: 'error' });
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [
    selectedIds,
    fetchLogs,
    timestamps,
    nameById,
    logsBgColor,
    logsTextColor,
    logsErrorColor,
    logsWarningColor,
    notify,
    record,
  ]);

  React.useEffect(() => {
    if (selectedIds.length === 0) {
      return;
    }

    void updateLogs();
  }, [selectedIds, timestamps, updateLogs]);

  // Live tail: poll while enabled + at least one container is selected + the tab is visible.
  React.useEffect(() => {
    if (selectedIds.length === 0 || !tailing) {
      return;
    }

    const tick = () => {
      if (document.hidden) {
        return;
      }

      const minInterval = errorCountRef.current > 0 ? LOGS_ERROR_POLL_INTERVAL_MS : LOGS_POLL_INTERVAL_MS;
      if (Date.now() - lastAttemptRef.current < minInterval) {
        return;
      }

      void updateLogs();
    };

    const intervalId = window.setInterval(tick, LOGS_POLL_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [selectedIds, tailing, updateLogs]);

  // Catch up immediately when the tab becomes visible again.
  React.useEffect(() => {
    if (selectedIds.length === 0 || !tailing) {
      return;
    }

    const onVisibilityChange = () => {
      if (!document.hidden) {
        void updateLogs();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [selectedIds, tailing, updateLogs]);

  React.useEffect(() => {
    if (loaded || !record) {
      return;
    }

    const loadContainers = async () => {
      let choices: ContainerChoice[] = [{ id: HOST_CONTAINER_ID, name: 'host' }];

      try {
        const installs = await dataProvider.getList<ResourceRecord>('image install', {
          pagination: { page: 1, perPage: 1000 },
          sort: { field: 'id', order: 'ASC' },
          filter: { device: record.id, status: 'Running' },
        });

        for (const install of installs.data) {
          const imageId = install['installs-image'];
          if (!imageId) {
            continue;
          }

          const images = await dataProvider.getList<ResourceRecord>('image', {
            pagination: { page: 1, perPage: 1000 },
            sort: { field: 'id', order: 'ASC' },
            filter: { id: imageId },
          });

          const imageRecord = images.data[0];
          if (!imageRecord) {
            continue;
          }

          const serviceId = imageRecord['is a build of-service'];
          if (!serviceId) {
            continue;
          }

          const services = await dataProvider.getList<ResourceRecord>('service', {
            pagination: { page: 1, perPage: 1000 },
            sort: { field: 'id', order: 'ASC' },
            filter: { id: serviceId },
          });

          const serviceRecord = services.data[0];
          if (!serviceRecord) {
            continue;
          }

          const idValue = typeof serviceRecord.id === 'number' ? serviceRecord.id : Number(serviceRecord.id);
          const nameValue = String(serviceRecord['service name'] ?? '');

          if (!Number.isNaN(idValue) && nameValue) {
            choices.push({ id: idValue, name: nameValue });
          }
        }
      } catch (error) {
        console.error(error);
        choices = [{ id: HOST_CONTAINER_ID, name: 'host' }];
      } finally {
        setContainers(choices);
        // Default to ALL: the pane starts tailing every container (host + services).
        setSelectedIds(choices.map((choice) => choice.id));
        setLoaded(true);
      }
    };

    void loadContainers();
  }, [dataProvider, loaded, record]);

  if (!record) {
    return null;
  }

  const toggleAll = () => {
    setSelectedIds(allSelected ? [] : containers.map((choice) => choice.id));
  };

  const onSelectionChange = (event: SelectChangeEvent<number[]>) => {
    const value = event.target.value;
    const ids = Array.isArray(value) ? value : [value];
    setSelectedIds(ids.map((id) => Number(id)).filter((id) => !Number.isNaN(id)));
  };

  return (
    <>
      <Box
        sx={{
          'display': 'flex',
          'padding': '5px 15px',
          'alignItems': 'center',
          '.MuiFormHelperText-root, .MuiFormLabel-root': {
            display: 'none',
          },
          '.MuiOutlinedInput-root': {
            height: '35px',
          },
        }}
      >
        <strong style={{ flex: 1 }}>Logs</strong>

        <Select
          multiple
          size='small'
          value={selectedIds}
          onChange={onSelectionChange}
          disabled={containers.length === 0}
          renderValue={(selected) => {
            if (containers.length > 0 && selected.length === containers.length) {
              return 'ALL';
            }

            if (selected.length === 0) {
              return 'None';
            }

            return selected.map((id) => nameById.get(Number(id)) ?? String(id)).join(', ');
          }}
          sx={{
            'minWidth': '120px',
            'maxWidth': '360px',
            '.MuiSelect-select': {
              padding: '9px 14px',
            },
          }}
          MenuProps={{
            slotProps: { paper: { sx: { maxHeight: '360px' } } },
          }}
        >
          <Box
            sx={{ display: 'flex', alignItems: 'center', px: 2, py: 0.75, cursor: 'pointer' }}
            onClick={(event) => {
              // Keep the menu open when toggling ALL.
              event.stopPropagation();
              event.preventDefault();
              toggleAll();
            }}
          >
            <Checkbox
              size='small'
              checked={allSelected}
              indeterminate={selectedIds.length > 0 && !allSelected}
              tabIndex={-1}
              disableRipple
            />
            <ListItemText primary='ALL' slotProps={{ primary: { fontWeight: 600 } }} />
          </Box>
          {containers.map((choice) => (
            <MenuItem key={choice.id} value={choice.id}>
              <Checkbox size='small' checked={selectedIds.includes(choice.id)} tabIndex={-1} disableRipple />
              <ListItemText primary={choice.name} />
            </MenuItem>
          ))}
        </Select>

        <IconButton
          disabled={selectedIds.length === 0}
          size='small'
          sx={{ ml: '5px', color: timestamps ? undefined : 'text.disabled' }}
          onClick={() => {
            setTimestamps((previous) => !previous);
          }}
          aria-label={timestamps ? 'Hide timestamps' : 'Show timestamps'}
          title={timestamps ? 'Hide timestamps' : 'Show timestamps'}
        >
          <AccessTimeIcon />
        </IconButton>

        <IconButton
          disabled={selectedIds.length === 0}
          size='small'
          sx={{ ml: '5px' }}
          onClick={() => {
            setTailing((previous) => !previous);
          }}
          aria-label={tailing ? 'Pause live tail' : 'Resume live tail'}
          title={tailing ? 'Pause live tail' : 'Resume live tail'}
        >
          {tailing ? <PauseIcon /> : <PlayArrowIcon />}
        </IconButton>

        <IconButton
          disabled={selectedIds.length === 0}
          size='small'
          sx={{ ml: '5px' }}
          onClick={() => {
            void updateLogs();
          }}
        >
          <RefreshIcon />
        </IconButton>
      </Box>

      <EmbeddedFrame srcDoc={displayContent} backgroundColor={logsBgColor} />
    </>
  );
};

export default DeviceLogs;
