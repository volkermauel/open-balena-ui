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
import {
  fetchHostosVersions,
  HostosVersionEntry,
  HostosVersionsResponse,
  seedHostosVersion,
} from '../lib/hostosRelease';

export interface HostosVersionsDialogProps {
  open: boolean;
  onClose: () => void;
  deviceTypeSlug: string;
}

type ImportPhase = 'idle' | 'importing';

const HOSTOS_IMPORT_HINT =
  'This may take a while: the hostOS image is copied into your registry on first import, which can take minutes.';

/**
 * Dialog listing the hostOS versions available in the ghcr mirror for a device
 * type, marking imported ones, and importing a selected version idempotently.
 * Imported versions appear in the device Target-OS selector without further
 * changes.
 */
const HostosVersionsDialog: React.FC<HostosVersionsDialogProps> = ({ open, onClose, deviceTypeSlug }) => {
  const [catalog, setCatalog] = React.useState<HostosVersionsResponse | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<HostosVersionEntry | null>(null);
  const [phase, setPhase] = React.useState<ImportPhase>('idle');
  const [importedVersion, setImportedVersion] = React.useState<string | null>(null);

  const loadVersions = React.useCallback(
    (signal: AbortSignal): Promise<void> =>
      fetchHostosVersions(deviceTypeSlug, signal)
        .then((data) => {
          if (!signal.aborted) {
            setCatalog(data);
          }
        })
        .catch((err: unknown) => {
          if (!signal.aborted) {
            setError(err instanceof Error ? err.message : 'Failed to load hostOS versions');
          }
        }),
    [deviceTypeSlug],
  );

  React.useEffect(() => {
    if (!open || !deviceTypeSlug) {
      return;
    }

    const controller = new AbortController();
    setCatalog(null);
    setError(null);
    setSelected(null);
    setImportedVersion(null);
    setPhase('idle');
    setIsLoading(true);

    void loadVersions(controller.signal).finally(() => {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    });

    return () => controller.abort();
  }, [open, deviceTypeSlug, loadVersions]);

  const canImport = selected !== null && !selected.seeded && selected.parsable && phase === 'idle';

  const importVersion = async (): Promise<void> => {
    if (!selected) {
      return;
    }

    setPhase('importing');
    setError(null);
    try {
      await seedHostosVersion(deviceTypeSlug, selected.version);
      setImportedVersion(selected.version);
      // Refresh the listing so the imported version shows its new state,
      // then return to idle so another version can be imported right away.
      const controller = new AbortController();
      await loadVersions(controller.signal);
      setSelected(null);
      setPhase('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'HostOS import failed');
      setPhase('idle');
    }
  };

  const renderVersionLabel = (entry: HostosVersionEntry): React.ReactNode => (
    <Box component='span' sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <span>{entry.version}</span>
      {entry.seeded && <Chip size='small' color='success' variant='outlined' label='imported' />}
      {!entry.seeded && entry.parsable && <Chip size='small' variant='outlined' label='available' />}
      {!entry.parsable && <Chip size='small' color='default' variant='outlined' label='not a version tag' />}
    </Box>
  );

  return (
    <Dialog open={open} onClose={phase === 'importing' ? undefined : onClose} maxWidth='sm' fullWidth>
      <DialogTitle>hostOS Versions</DialogTitle>
      <DialogContent>
        <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
          Device type <strong>{deviceTypeSlug}</strong> — versions published at the configured ghcr mirror. Imported
          versions become selectable in the device Target-OS selector.
          {catalog ? (
            <>
              {' Source: '}
              <a href={`https://github.com/${catalog.sourceRepo}/releases`} target='_blank' rel='noreferrer'>
                {catalog.sourceRepo}
              </a>
            </>
          ) : null}
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

        {!isLoading && catalog && phase !== 'importing' && (
          <List
            dense
            sx={{ maxHeight: 320, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
          >
            {catalog.versions.length === 0 && (
              <ListItemButton disabled>
                <ListItemText primary='No hostOS versions found for this device type' />
              </ListItemButton>
            )}
            {catalog.versions.map((entry) => {
              const selectable = !entry.seeded && entry.parsable;
              return (
                <ListItemButton
                  key={entry.rawVersion}
                  disabled={!selectable}
                  selected={selected?.rawVersion === entry.rawVersion}
                  onClick={() => setSelected(entry)}
                >
                  <ListItemText
                    primary={renderVersionLabel(entry)}
                    secondary={
                      entry.rawVersion !== entry.version
                        ? `mirror tag: ${entry.rawVersion}`
                        : entry.parsable
                          ? undefined
                          : 'Cannot be imported: the tag is not a version'
                    }
                  />
                </ListItemButton>
              );
            })}
          </List>
        )}

        {phase === 'importing' && (
          <Box sx={{ mt: 2, mb: 1 }}>
            <LinearProgress />
            <Typography variant='body2' sx={{ mt: 1 }}>
              Importing hostOS {selected?.version}: mirroring image bytes into your registry…
            </Typography>
            <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
              {HOSTOS_IMPORT_HINT}
            </Typography>
          </Box>
        )}

        {phase !== 'importing' && importedVersion && (
          <Alert severity='success' sx={{ mt: 1 }}>
            hostOS {importedVersion} imported — it is now selectable in the device Target-OS selector.
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={phase === 'importing'}>
          {importedVersion ? 'Close' : 'Cancel'}
        </Button>
        <Button variant='contained' onClick={importVersion} disabled={!canImport}>
          {phase === 'importing' ? 'Importing…' : 'Import'}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default HostosVersionsDialog;
