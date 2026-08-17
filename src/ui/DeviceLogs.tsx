import { Box, useTheme } from '@mui/material';
import IconButton from '@mui/material/IconButton';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import React from 'react';
import { Form, SelectInput, useAuthProvider, useDataProvider, useRecordContext, useNotify } from 'react-admin';
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

// Live-tail polling. While tailing is enabled, a container is selected and the
// tab is visible, the api logs endpoint is polled once per interval and the pane
// scrolls to the newest entry (matching the official balena dashboard behaviour).
const LOGS_POLL_INTERVAL_MS = 1000;
// After a failed request, poll slower until one succeeds to avoid hammering the
// api (e.g. device offline, api restarting).
const LOGS_ERROR_POLL_INTERVAL_MS = 5000;

export const DeviceLogs: React.FC = () => {
  const record = useRecordContext<DeviceRecord>();
  const [loaded, setLoaded] = React.useState(false);
  const [containers, setContainers] = React.useState<ContainerChoice[]>([]);
  const [container, setContainer] = React.useState<number | 'default'>('default');
  const [content, setContent] = React.useState('');
  const [tailing, setTailing] = React.useState(true);
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
    if (container === 'default' || inFlightRef.current) {
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

      const filteredLogs = logs.filter((entry) => {
        if (container === 0) {
          return !Object.prototype.hasOwnProperty.call(entry, 'serviceId') || entry.serviceId == null;
        }

        return Number(entry.serviceId) === Number(container);
      });

      let nextContent = '';
      if (filteredLogs.length) {
        const formattedLogs = filteredLogs
          .map((entry) => {
            const time = new Date(entry.timestamp).toISOString();
            const message = entry.message ?? '';

            if (entry.isStdErr) {
              return `[${time}] <span style="color: ${logsErrorColor}; ">${message}</span>`;
            }

            if (entry.isSystem) {
              return `[${time}] <span style="color: ${logsWarningColor}; ">${message}</span>`;
            }

            return `[${time}] ${message}`;
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
  }, [container, fetchLogs, logsBgColor, logsTextColor, logsErrorColor, logsWarningColor, notify, record]);

  React.useEffect(() => {
    if (container === 'default') {
      return;
    }

    void updateLogs();
  }, [container, updateLogs]);

  // Live tail: poll while enabled + a container is selected + the tab is visible.
  React.useEffect(() => {
    if (container === 'default' || !tailing) {
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
  }, [container, tailing, updateLogs]);

  // Catch up immediately when the tab becomes visible again.
  React.useEffect(() => {
    if (container === 'default' || !tailing) {
      return;
    }

    const onVisibilityChange = () => {
      if (!document.hidden) {
        void updateLogs();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [container, tailing, updateLogs]);

  React.useEffect(() => {
    if (loaded || !record) {
      return;
    }

    const loadContainers = async () => {
      try {
        const installs = await dataProvider.getList<ResourceRecord>('image install', {
          pagination: { page: 1, perPage: 1000 },
          sort: { field: 'id', order: 'ASC' },
          filter: { device: record.id, status: 'Running' },
        });

        const choices: ContainerChoice[] = [{ id: 0, name: 'host' }];

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

        setContainers(choices);
      } catch (error) {
        console.error(error);
        setContainers([{ id: 0, name: 'host' }]);
      } finally {
        setLoaded(true);
      }
    };

    void loadContainers();
  }, [dataProvider, loaded, record]);

  if (!record) {
    return null;
  }

  return (
    <>
      <Form>
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
            '.MuiSelect-select': {
              padding: '9px 14px',
            },
          }}
        >
          <strong style={{ flex: 1 }}>Logs</strong>

          <SelectInput
            source='container'
            disabled={containers.length === 0}
            choices={containers}
            defaultValue='default'
            emptyText='Select Container'
            emptyValue='default'
            size='small'
            label=''
            onChange={(event) => {
              const value = event.target.value;

              if (value === 'default') {
                setContainer('default');
                return;
              }

              if (typeof value === 'number') {
                setContainer(value);
                return;
              }

              const numericValue = Number(value);
              setContainer(Number.isNaN(numericValue) ? 'default' : numericValue);
            }}
          />

          <IconButton
            disabled={container === 'default'}
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
            disabled={container === 'default'}
            size='small'
            sx={{ ml: '5px' }}
            onClick={() => {
              void updateLogs();
            }}
          >
            <RefreshIcon />
          </IconButton>
        </Box>
      </Form>

      <EmbeddedFrame srcDoc={displayContent} backgroundColor={logsBgColor} />
    </>
  );
};

export default DeviceLogs;
