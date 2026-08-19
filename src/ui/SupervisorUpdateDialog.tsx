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
  LinearProgress,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import {
  fetchSupervisorVersions,
  isDowngrade,
  isSameSupervisorVersion,
  SupervisorDeviceUpdateResult,
  SupervisorVersionEntry,
  SupervisorVersionsResponse,
  updateSupervisorVersions,
} from '../lib/supervisorRelease';

export interface SupervisorUpdateDialogProps {
  open: boolean;
  onClose: () => void;
  deviceTypeSlug: string;
  currentVersion?: string | null;
  deviceIds: number[];
  title?: string;
  /** Called once after a successful apply — lets parents refresh stale state. */
  onUpdated?: () => void;
}

type ApplyPhase = 'idle' | 'applying' | 'done';

/** Importing happens exclusively on the arch-scoped Supervisor Versions dialog
 * (Device Types page) — this dialog only pins already-imported versions. */
const SUPERVISOR_IMPORT_POINTER =
  'Only imported supervisor versions are listed. Import more via “Supervisor Versions” on the Device Types page.';

/**
 * Dialog listing the supervisor versions available for a device type, marking
 * the current one, disabling downgrades, and applying the selected version to
 * the given devices (the server seeds the version implicitly when needed).
 */
const SupervisorUpdateDialog: React.FC<SupervisorUpdateDialogProps> = ({
  open,
  onClose,
  deviceTypeSlug,
  currentVersion,
  deviceIds,
  title,
  onUpdated,
}) => {
  const [catalog, setCatalog] = React.useState<SupervisorVersionsResponse | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<SupervisorVersionEntry | null>(null);
  const [phase, setPhase] = React.useState<ApplyPhase>('idle');
  const [results, setResults] = React.useState<SupervisorDeviceUpdateResult[] | null>(null);

  React.useEffect(() => {
    if (!open || !deviceTypeSlug) {
      return;
    }

    const controller = new AbortController();
    setCatalog(null);
    setError(null);
    setSelected(null);
    setResults(null);
    setPhase('idle');
    setIsLoading(true);

    fetchSupervisorVersions(deviceTypeSlug)
      .then((data) => {
        if (!controller.signal.aborted) {
          setCatalog(data);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load supervisor versions');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => controller.abort();
  }, [open, deviceTypeSlug]);

  const isBulk = deviceIds.length > 1;
  const canApply = selected !== null && phase === 'idle';

  const apply = async (): Promise<void> => {
    if (!selected) {
      return;
    }

    setPhase('applying');
    setError(null);
    try {
      const response = await updateSupervisorVersions(deviceTypeSlug, selected.version, deviceIds);
      setResults(response.results);
      setPhase('done');
      onUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Supervisor update failed');
      setPhase('idle');
    }
  };

  const renderVersionLabel = (entry: SupervisorVersionEntry): React.ReactNode => {
    const current = isSameSupervisorVersion(entry.version, currentVersion);
    const downgrade = isDowngrade(entry.version, currentVersion ?? null);
    return (
      <Box component='span' sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <span>{entry.version}</span>
        {current && <Chip size='small' color='info' variant='outlined' label='current' />}
        {downgrade && <Chip size='small' color='default' variant='outlined' label='downgrade not allowed' />}
      </Box>
    );
  };

  return (
    <Dialog open={open} onClose={phase === 'applying' ? undefined : onClose} maxWidth='sm' fullWidth>
      <DialogTitle>{title ?? 'Update Supervisor'}</DialogTitle>
      <DialogContent>
        <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
          Architecture <strong>{catalog?.arch ?? '…'}</strong>
          {currentVersion ? (
            <>
              {' — current supervisor version '}
              <strong>{currentVersion}</strong>
            </>
          ) : null}
          {isBulk ? ` — ${deviceIds.length} devices selected` : ''}
        </Typography>

        {error && (
          <Alert severity='error' sx={{ mt: 1, mb: 1 }}>
            {error}
          </Alert>
        )}

        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
            <CircularProgress size={24} />
          </Box>
        )}

        {!isLoading && catalog && phase !== 'applying' && (
          <List
            dense
            sx={{ maxHeight: 320, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
          >
            {catalog.versions.filter((entry) => entry.seeded).length === 0 && (
              <ListItemButton disabled>
                <ListItemText primary='No supervisor versions imported for this architecture yet' />
              </ListItemButton>
            )}
            {catalog.versions
              .filter((entry) => entry.seeded)
              .map((entry) => {
                const downgrade = isDowngrade(entry.version, currentVersion ?? null);
                const selectable = !downgrade;
                return (
                  <ListItemButton
                    key={entry.version}
                    disabled={!selectable}
                    selected={selected?.version === entry.version}
                    onClick={() => setSelected(entry)}
                  >
                    <ListItemText
                      primary={renderVersionLabel(entry)}
                      secondary={
                        downgrade
                          ? 'Downgrading the supervisor is not allowed'
                          : entry.rawVersion !== entry.version
                            ? `raw: ${entry.rawVersion}`
                            : undefined
                      }
                    />
                  </ListItemButton>
                );
              })}
          </List>
        )}

        {phase === 'applying' && (
          <Box sx={{ mt: 2, mb: 1 }}>
            <LinearProgress />
            <Typography variant='body2' sx={{ mt: 1 }}>
              Applying update to devices…
            </Typography>
          </Box>
        )}

        {phase !== 'applying' && catalog && catalog.versions.some((entry) => !entry.seeded) && (
          <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 1 }}>
            {SUPERVISOR_IMPORT_POINTER}
          </Typography>
        )}

        {phase === 'done' && results && (
          <Box sx={{ mt: 1 }}>
            <Typography variant='subtitle2' gutterBottom>
              {results.every((result) => result.ok)
                ? `Done — supervisor target set to ${selected?.version} for ${results.length} device(s)`
                : `Finished with ${results.filter((result) => !result.ok).length} rejection(s):`}
            </Typography>
            <List dense>
              {results.map((result) => (
                <ListItemButton key={result.id} disabled sx={{ cursor: 'default' }}>
                  {result.ok ? (
                    <CheckIcon color='success' fontSize='small' sx={{ mr: 1 }} />
                  ) : (
                    <CloseIcon color='error' fontSize='small' sx={{ mr: 1 }} />
                  )}
                  <ListItemText primary={`Device ${result.id}`} secondary={result.ok ? undefined : result.message} />
                </ListItemButton>
              ))}
            </List>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={phase === 'applying'}>
          {phase === 'done' ? 'Close' : 'Cancel'}
        </Button>
        <Button variant='contained' onClick={apply} disabled={!canApply}>
          {phase === 'applying' ? 'Updating…' : `Update${isBulk ? ` ${deviceIds.length} devices` : ''}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SupervisorUpdateDialog;
