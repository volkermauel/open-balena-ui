import React from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormHelperText,
  FormLabel,
  InputLabel,
  LinearProgress,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  TextField,
} from '@mui/material';
import { useDataProvider } from 'react-admin';
import type { DataProvider } from 'react-admin';
import DownloadIcon from '@mui/icons-material/Download';
import DescriptionIcon from '@mui/icons-material/Description';
import type { ResourceRecord } from '../types/resource';
import {
  downloadOsImageArtifact,
  downloadOsImageConfig,
  fetchOsImageCacheStatus,
  fetchOsImageJob,
  fetchOsImageVersions,
  mergeFleetRecords,
  prepareOsImage,
  type OsImageFormat,
  type OsImageJob,
  type OsImageNetwork,
  type OsImageRequestError,
} from '../lib/osImage';

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 30000;

export interface OsDownloadDialogProps {
  open: boolean;
  onClose: () => void;
  initialFleetId?: string | number;
  /** The launching fleet record itself — seeds the dropdown so it is never empty on open. */
  initialFleetRecord?: ResourceRecord;
  initialDeviceTypeSlug?: string;
  /** Device type resource id (fleet records reference device types by id, not slug). */
  initialDeviceTypeId?: string | number;
}

const PHASE_LABELS: Record<string, string> = {
  downloading: 'Downloading OS image from the mirror',
  injecting: 'Injecting fleet configuration',
  compressing: 'Compressing provisioned image',
  ready: 'Artifact ready',
  error: 'Failed',
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 'B';
  for (const nextUnit of units) {
    if (value < 1024) {
      break;
    }
    value /= 1024;
    unit = nextUnit;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
};

export const OsDownloadDialog: React.FC<OsDownloadDialogProps> = ({
  open,
  onClose,
  initialFleetId,
  initialFleetRecord,
  initialDeviceTypeSlug,
  initialDeviceTypeId,
}) => {
  const dataProvider = useDataProvider<DataProvider>();

  const [deviceTypes, setDeviceTypes] = React.useState<ResourceRecord[]>([]);
  const [fleets, setFleets] = React.useState<ResourceRecord[]>(initialFleetRecord ? [initialFleetRecord] : []);
  const [deviceTypeSlug, setDeviceTypeSlug] = React.useState(initialDeviceTypeSlug ?? '');
  const [versions, setVersions] = React.useState<string[]>([]);
  const [cachedVersions, setCachedVersions] = React.useState<Set<string>>(new Set());
  const [versionsLoading, setVersionsLoading] = React.useState(false);
  const [versionsError, setVersionsError] = React.useState<string | null>(null);
  // Fleet/device-type load failures land here, separate from version-list errors.
  const [choicesError, setChoicesError] = React.useState<string | null>(null);

  const [version, setVersion] = React.useState('');
  // The mirror publishes production images only — the variant selector is gone.
  const variant = 'production' as const;
  const [format, setFormat] = React.useState<OsImageFormat>('zip');
  const [fleetId, setFleetId] = React.useState(initialFleetId !== undefined ? String(initialFleetId) : '');
  const [network, setNetwork] = React.useState<OsImageNetwork>('ethernet');
  // Wifi credentials are opt-in for every network choice (checkbox below); selecting
  // the wifi network implies them.
  const [wifiEnabled, setWifiEnabled] = React.useState(false);
  const [wifiSsid, setWifiSsid] = React.useState('');
  const [wifiKey, setWifiKey] = React.useState('');
  const [appUpdatePollInterval, setAppUpdatePollInterval] = React.useState('');
  const [job, setJob] = React.useState<OsImageJob | null>(null);
  const [jobError, setJobError] = React.useState<string | null>(null);
  const [savedFilename, setSavedFilename] = React.useState<string | null>(null);
  const [configBusy, setConfigBusy] = React.useState(false);
  const [configError, setConfigError] = React.useState<string | null>(null);
  const [configSaved, setConfigSaved] = React.useState<string | null>(null);
  const pollTimer = React.useRef<number | null>(null);
  // Tracks whether the dialog is open so in-flight poll callbacks can stop early (see pollJob).
  const dialogOpenRef = React.useRef(open);
  dialogOpenRef.current = open;

  const clearPollTimer = () => {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  React.useEffect(() => clearPollTimer, []);

  const resetJobState = () => {
    clearPollTimer();
    setJob(null);
    setJobError(null);
    setSavedFilename(null);
    setConfigBusy(false);
    setConfigError(null);
    setConfigSaved(null);
  };

  React.useEffect(() => {
    if (!open) {
      resetJobState();
      return;
    }

    let cancelled = false;
    setChoicesError(null);
    const fetchChoices = async () => {
      try {
        const [deviceTypeRecords, fleetRecords] = await Promise.all([
          dataProvider.getList<ResourceRecord>('device type', {
            pagination: { page: 1, perPage: 1000 },
            sort: { field: 'slug', order: 'ASC' },
            filter: {},
          }),
          dataProvider.getList<ResourceRecord>('application', {
            pagination: { page: 1, perPage: 1000 },
            sort: { field: 'app name', order: 'ASC' },
            filter: {},
          }),
        ]);
        if (cancelled) {
          return;
        }
        setDeviceTypes(deviceTypeRecords.data);
        // Server records win; the launching fleet stays selectable even if the
        // list request returns nothing usable (openBalena lacks the class filter).
        setFleets(mergeFleetRecords(initialFleetRecord ? [initialFleetRecord] : [], fleetRecords.data));

        if (!initialDeviceTypeSlug && initialDeviceTypeId !== undefined) {
          const matched = deviceTypeRecords.data.find((record) => String(record.id) === String(initialDeviceTypeId));
          if (matched && typeof matched.slug === 'string') {
            setDeviceTypeSlug(matched.slug);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setChoicesError(error instanceof Error ? error.message : 'Failed to load fleets or device types');
        }
      }
    };

    void fetchChoices();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dataProvider]);

  React.useEffect(() => {
    if (!open || !deviceTypeSlug) {
      return;
    }

    let cancelled = false;
    setVersionsLoading(true);
    setVersionsError(null);
    setVersion('');

    const fetchVersions = async () => {
      try {
        const [versionList, cacheStatus] = await Promise.all([
          fetchOsImageVersions(deviceTypeSlug),
          fetchOsImageCacheStatus(deviceTypeSlug),
        ]);
        if (cancelled) {
          return;
        }
        setVersions(versionList.versions);
        setCachedVersions(
          new Set(
            cacheStatus.versions
              .filter((entry) => entry.variant === variant && entry.cached)
              .map((entry) => entry.version),
          ),
        );
      } catch (error) {
        if (!cancelled) {
          setVersions([]);
          setCachedVersions(new Set());
          setVersionsError(error instanceof Error ? error.message : 'Failed to load OS versions');
        }
      } finally {
        if (!cancelled) {
          setVersionsLoading(false);
        }
      }
    };

    void fetchVersions();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, deviceTypeSlug]);

  const pollJob = (jobId: string, intervalMs: number) => {
    pollTimer.current = window.setTimeout(async () => {
      try {
        const currentJob = await fetchOsImageJob(jobId);
        if (!dialogOpenRef.current) {
          // Dialog closed while the poll was in flight: stop polling and never auto-download.
          return;
        }
        setJob(currentJob);

        if (currentJob.phase === 'ready') {
          try {
            const filename = await downloadOsImageArtifact(currentJob);
            setSavedFilename(filename);
          } catch (error) {
            setJobError(error instanceof Error ? error.message : 'Failed to download the prepared artifact');
          }
          return;
        }
        if (currentJob.phase === 'error') {
          return;
        }
        pollJob(jobId, POLL_INTERVAL_MS);
      } catch (error) {
        const status = (error as OsImageRequestError).status;
        if (status === 429) {
          // The shared dosProtect rate limiter kicks in for long polls; back off.
          pollJob(jobId, Math.min(intervalMs * 2, MAX_POLL_INTERVAL_MS));
          return;
        }
        setJobError(error instanceof Error ? error.message : 'Failed to poll OS image job');
      }
    }, intervalMs);
  };

  const busy = job !== null && job.phase !== 'ready' && job.phase !== 'error';

  const handleDownload = async () => {
    const selectedFleet = fleets.find((record) => String(record.id) === fleetId);

    if (!deviceTypeSlug || !version || !selectedFleet) {
      setJobError('Device type, version and fleet are required');
      return;
    }
    if (network === 'wifi' && !wifiSsid) {
      setJobError('A wifi SSID is required when provisioning for wifi');
      return;
    }

    resetJobState();
    setJob({
      jobId: '',
      phase: 'downloading',
    });

    try {
      const { jobId } = await prepareOsImage({
        deviceType: deviceTypeSlug,
        version,
        variant,
        format,
        appId: Number(selectedFleet.id),
        fleetName: typeof selectedFleet['app name'] === 'string' ? selectedFleet['app name'] : String(selectedFleet.id),
        network,
        ...(appUpdatePollInterval.trim().length > 0 ? { appUpdatePollInterval: Number(appUpdatePollInterval) } : {}),
        ...(network === 'wifi' || wifiEnabled ? (wifiSsid ? { wifiSsid } : {}) : {}),
        ...(network === 'wifi' || wifiEnabled ? (wifiKey ? { wifiKey } : {}) : {}),
        ...(network === 'wifi' && wifiKey ? { wifiKey } : {}),
      });
      if (!dialogOpenRef.current) {
        // Dialog closed while the prepare request was in flight: do not start polling.
        return;
      }
      setJob({ jobId, phase: 'downloading' });
      pollJob(jobId, POLL_INTERVAL_MS);
    } catch (error) {
      setJob(null);
      setJobError(error instanceof Error ? error.message : 'Failed to start OS image preparation');
    }
  };

  const handleDownloadConfig = async () => {
    const selectedFleet = fleets.find((record) => String(record.id) === fleetId);

    if (!deviceTypeSlug || !version || !selectedFleet) {
      setConfigError('Device type, version and fleet are required');
      return;
    }
    if (network === 'wifi' && !wifiSsid) {
      setConfigError('A wifi SSID is required when provisioning for wifi');
      return;
    }

    setConfigBusy(true);
    setConfigError(null);
    setConfigSaved(null);
    try {
      const filename = await downloadOsImageConfig({
        deviceType: deviceTypeSlug,
        version,
        appId: Number(selectedFleet.id),
        fleetName: typeof selectedFleet['app name'] === 'string' ? selectedFleet['app name'] : String(selectedFleet.id),
        network,
        ...(appUpdatePollInterval.trim().length > 0 ? { appUpdatePollInterval: Number(appUpdatePollInterval) } : {}),
        ...(network === 'wifi' || wifiEnabled ? (wifiSsid ? { wifiSsid } : {}) : {}),
        ...(network === 'wifi' || wifiEnabled ? (wifiKey ? { wifiKey } : {}) : {}),
      });
      setConfigSaved(filename);
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : 'Failed to download the config');
    } finally {
      setConfigBusy(false);
    }
  };

  const progressPercent =
    job?.progress && job.progress.totalBytes
      ? Math.min(100, Math.round((job.progress.downloadedBytes / job.progress.totalBytes) * 100))
      : null;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth='sm'>
      <DialogTitle>Download Provisioned OS Image</DialogTitle>

      <DialogContent dividers>
        {versionsError && (
          <Alert severity='error' sx={{ mb: 2 }}>
            {versionsError}
          </Alert>
        )}
        {jobError && (
          <Alert severity='error' sx={{ mb: 2 }}>
            {jobError}
          </Alert>
        )}
        {savedFilename && (
          <Alert severity='success' sx={{ mb: 2 }}>
            OS image saved as {savedFilename}
          </Alert>
        )}
        {configError && (
          <Alert severity='error' sx={{ mb: 2 }}>
            {configError}
          </Alert>
        )}
        {configSaved && (
          <Alert severity='success' sx={{ mb: 2 }}>
            Config saved as {configSaved}
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
          <FormControl fullWidth disabled={busy}>
            <InputLabel id='os-download-device-type'>Device type</InputLabel>
            <Select
              labelId='os-download-device-type'
              value={deviceTypeSlug}
              label='Device type'
              onChange={(event) => setDeviceTypeSlug(event.target.value)}
            >
              {deviceTypes.map((record) => (
                <MenuItem key={String(record.id)} value={String(record.slug)}>
                  {String(record.slug)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth disabled={busy || !deviceTypeSlug || versionsLoading}>
            <InputLabel id='os-download-version'>Version</InputLabel>
            <Select
              labelId='os-download-version'
              value={version}
              label='Version'
              onChange={(event) => setVersion(event.target.value)}
            >
              {versions.map((entry) => (
                <MenuItem key={entry} value={entry}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                    <span>{entry}</span>
                    {cachedVersions.has(entry) && (
                      <Chip size='small' color='success' variant='outlined' label='cached' sx={{ ml: 'auto' }} />
                    )}
                  </Box>
                </MenuItem>
              ))}
            </Select>
            {versionsLoading && <FormHelperText>Loading available versions…</FormHelperText>}
          </FormControl>

          <FormControl disabled={busy}>
            <FormLabel id='os-download-format'>Format</FormLabel>
            <RadioGroup
              row
              aria-labelledby='os-download-format'
              value={format}
              onChange={(event) => setFormat(event.target.value as OsImageFormat)}
            >
              <FormControlLabel value='zip' control={<Radio />} label='.zip' />
              <FormControlLabel value='gz' control={<Radio />} label='.gz' />
            </RadioGroup>
          </FormControl>

          {choicesError && (
            <Alert severity='error' sx={{ mb: 2 }}>
              {choicesError}
            </Alert>
          )}

          <FormControl fullWidth disabled={busy}>
            <InputLabel id='os-download-fleet'>Fleet</InputLabel>
            <Select
              labelId='os-download-fleet'
              value={fleetId}
              label='Fleet'
              onChange={(event) => setFleetId(event.target.value)}
            >
              {fleets.map((record) => (
                <MenuItem key={String(record.id)} value={String(record.id)}>
                  {String(record['app name'] ?? record.id)}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl disabled={busy}>
            <FormLabel id='os-download-network'>Network</FormLabel>
            <RadioGroup
              row
              aria-labelledby='os-download-network'
              value={network}
              onChange={(event) => setNetwork(event.target.value as OsImageNetwork)}
            >
              <FormControlLabel value='ethernet' control={<Radio />} label='Ethernet' />
              <FormControlLabel value='wifi' control={<Radio />} label='Wifi' />
            </RadioGroup>
          </FormControl>

          <FormControlLabel
            label='Add wifi credentials'
            control={
              <Checkbox
                checked={network === 'wifi' || wifiEnabled}
                onChange={(event) => setWifiEnabled(event.target.checked)}
                // Choosing the wifi network implies the credentials; they cannot be turned off there.
                disabled={busy || configBusy || network === 'wifi'}
              />
            }
          />
          {(network === 'wifi' || wifiEnabled) && (
            <>
              <TextField
                label={network === 'wifi' ? 'Wifi SSID (required)' : 'Wifi SSID'}
                value={wifiSsid}
                onChange={(event) => setWifiSsid(event.target.value)}
                disabled={busy || configBusy}
                fullWidth
              />
              <TextField
                label='Wifi key'
                type='password'
                value={wifiKey}
                onChange={(event) => setWifiKey(event.target.value)}
                disabled={busy || configBusy}
                fullWidth
              />
            </>
          )}

          <TextField
            label='App update poll interval (minutes)'
            type='number'
            value={appUpdatePollInterval}
            onChange={(event) => setAppUpdatePollInterval(event.target.value)}
            disabled={busy}
            slotProps={{ htmlInput: { min: 1 } }}
            fullWidth
          />

          {job && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                {busy && <CircularProgress size={16} />}
                <span>
                  {PHASE_LABELS[job.phase] ?? job.phase}
                  {job.phase === 'downloading' && job.progress
                    ? ` (${formatBytes(job.progress.downloadedBytes)}${
                        job.progress.totalBytes ? ` of ${formatBytes(job.progress.totalBytes)}` : ''
                      })`
                    : ''}
                </span>
              </Box>
              {(busy || job.phase === 'ready') && (
                <LinearProgress
                  variant={progressPercent !== null ? 'determinate' : 'indeterminate'}
                  {...(progressPercent !== null ? { value: progressPercent } : {})}
                />
              )}
            </Box>
          )}
        </Box>
      </DialogContent>

      <DialogActions className='custom'>
        <Button variant='outlined' onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button
          variant='outlined'
          onClick={handleDownloadConfig}
          disabled={busy || configBusy || !deviceTypeSlug || !version || !fleetId || versionsLoading}
          startIcon={configBusy ? <CircularProgress size={18} /> : <DescriptionIcon />}
        >
          Config only
        </Button>
        <Button
          variant='contained'
          onClick={handleDownload}
          disabled={busy || configBusy || !deviceTypeSlug || !version || !fleetId || versionsLoading}
          startIcon={<DownloadIcon />}
        >
          Download
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default OsDownloadDialog;
