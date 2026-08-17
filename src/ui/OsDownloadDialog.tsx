import React from 'react';
import {
  Alert,
  Box,
  Button,
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
import type { ResourceRecord } from '../types/resource';
import {
  downloadOsImageArtifact,
  fetchOsImageCacheStatus,
  fetchOsImageJob,
  fetchOsImageVersions,
  prepareOsImage,
  type OsImageFormat,
  type OsImageJob,
  type OsImageNetwork,
  type OsImageRequestError,
  type OsImageVariant,
} from '../lib/osImage';

const POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 30000;

export interface OsDownloadDialogProps {
  open: boolean;
  onClose: () => void;
  initialFleetId?: string | number;
  initialDeviceTypeSlug?: string;
  /** Device type resource id (fleet records reference device types by id, not slug). */
  initialDeviceTypeId?: string | number;
}

const PHASE_LABELS: Record<string, string> = {
  downloading: 'Downloading OS image from balenaCloud',
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
  initialDeviceTypeSlug,
  initialDeviceTypeId,
}) => {
  const dataProvider = useDataProvider<DataProvider>();

  const [deviceTypes, setDeviceTypes] = React.useState<ResourceRecord[]>([]);
  const [fleets, setFleets] = React.useState<ResourceRecord[]>([]);
  const [deviceTypeSlug, setDeviceTypeSlug] = React.useState(initialDeviceTypeSlug ?? '');
  const [versions, setVersions] = React.useState<string[]>([]);
  const [cachedVersions, setCachedVersions] = React.useState<Set<string>>(new Set());
  const [versionsLoading, setVersionsLoading] = React.useState(false);
  const [versionsError, setVersionsError] = React.useState<string | null>(null);

  const [version, setVersion] = React.useState('');
  const [variant, setVariant] = React.useState<OsImageVariant>('production');
  const [format, setFormat] = React.useState<OsImageFormat>('zip');
  const [fleetId, setFleetId] = React.useState(initialFleetId !== undefined ? String(initialFleetId) : '');
  const [network, setNetwork] = React.useState<OsImageNetwork>('ethernet');
  const [wifiSsid, setWifiSsid] = React.useState('');
  const [wifiKey, setWifiKey] = React.useState('');
  const [appUpdatePollInterval, setAppUpdatePollInterval] = React.useState('');

  const [job, setJob] = React.useState<OsImageJob | null>(null);
  const [jobError, setJobError] = React.useState<string | null>(null);
  const [savedFilename, setSavedFilename] = React.useState<string | null>(null);
  const pollTimer = React.useRef<number | null>(null);

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
  };

  React.useEffect(() => {
    if (!open) {
      resetJobState();
      return;
    }

    let cancelled = false;
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
            filter: { 'is of-class': 'fleet' },
          }),
        ]);
        if (cancelled) {
          return;
        }
        setDeviceTypes(deviceTypeRecords.data);
        setFleets(fleetRecords.data);

        if (!initialDeviceTypeSlug && initialDeviceTypeId !== undefined) {
          const matched = deviceTypeRecords.data.find((record) => String(record.id) === String(initialDeviceTypeId));
          if (matched && typeof matched.slug === 'string') {
            setDeviceTypeSlug(matched.slug);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setVersionsError(error instanceof Error ? error.message : 'Failed to load fleets or device types');
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

  React.useEffect(() => {
    if (!open || !deviceTypeSlug || versionsLoading) {
      return;
    }
    setCachedVersions((previous) => previous); // variant switch keeps the set until refreshed
    let cancelled = false;
    const refreshCacheStatus = async () => {
      try {
        const cacheStatus = await fetchOsImageCacheStatus(deviceTypeSlug);
        if (cancelled) {
          return;
        }
        setCachedVersions(
          new Set(
            cacheStatus.versions
              .filter((entry) => entry.variant === variant && entry.cached)
              .map((entry) => entry.version),
          ),
        );
      } catch {
        // Badges are best-effort; keep the previous set.
      }
    };
    void refreshCacheStatus();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  const pollJob = (jobId: string, intervalMs: number) => {
    pollTimer.current = window.setTimeout(async () => {
      try {
        const currentJob = await fetchOsImageJob(jobId);
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
        ...(network === 'wifi' && wifiSsid ? { wifiSsid } : {}),
        ...(network === 'wifi' && wifiKey ? { wifiKey } : {}),
      });
      setJob({ jobId, phase: 'downloading' });
      pollJob(jobId, POLL_INTERVAL_MS);
    } catch (error) {
      setJob(null);
      setJobError(error instanceof Error ? error.message : 'Failed to start OS image preparation');
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
            <FormLabel id='os-download-variant'>Variant</FormLabel>
            <RadioGroup
              row
              aria-labelledby='os-download-variant'
              value={variant}
              onChange={(event) => setVariant(event.target.value as OsImageVariant)}
            >
              <FormControlLabel value='production' control={<Radio />} label='Production' />
              <FormControlLabel value='development' control={<Radio />} label='Development' />
            </RadioGroup>
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

          {network === 'wifi' && (
            <>
              <TextField
                label='Wifi SSID'
                value={wifiSsid}
                onChange={(event) => setWifiSsid(event.target.value)}
                disabled={busy}
                fullWidth
              />
              <TextField
                label='Wifi key'
                type='password'
                value={wifiKey}
                onChange={(event) => setWifiKey(event.target.value)}
                disabled={busy}
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
          variant='contained'
          onClick={handleDownload}
          disabled={busy || !deviceTypeSlug || !version || !fleetId || versionsLoading}
          startIcon={<DownloadIcon />}
        >
          Download
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default OsDownloadDialog;
