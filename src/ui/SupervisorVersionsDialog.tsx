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
  MenuItem,
  Select,
  Typography,
} from '@mui/material';
import {
  fetchSupervisorArches,
  fetchSupervisorVersionsForArch,
  importSupervisorVersion,
  SupervisorVersionEntry,
  SupervisorVersionsResponse,
} from '../lib/supervisorRelease';

export interface SupervisorVersionsDialogProps {
  open: boolean;
  onClose: () => void;
}

type ImportPhase = 'idle' | 'importing';

const SUPERVISOR_IMPORT_HINT =
  'This may take a while: the supervisor image (~150 MB) is copied into your registry on first import, which can take minutes.';

/**
 * Arch-scoped supervisor import dialog: the supervisor depends only on the CPU
 * architecture, never on the device make/model, so versions are imported once
 * per architecture (one application and one registry repo per arch) and become
 * selectable when updating a device's supervisor.
 */
const SupervisorVersionsDialog: React.FC<SupervisorVersionsDialogProps> = ({ open, onClose }) => {
  const [arches, setArches] = React.useState<string[]>([]);
  const [arch, setArch] = React.useState<string>('');
  const [catalog, setCatalog] = React.useState<SupervisorVersionsResponse | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<SupervisorVersionEntry | null>(null);
  const [phase, setPhase] = React.useState<ImportPhase>('idle');
  const [importedVersion, setImportedVersion] = React.useState<string | null>(null);

  // Load the arch picker once per open.
  React.useEffect(() => {
    if (!open) {
      return;
    }
    const controller = new AbortController();
    setError(null);
    fetchSupervisorArches(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) {
          return;
        }
        setArches(data.arches);
        setArch((current) =>
          current || data.arches.includes('aarch64') ? current || 'aarch64' : (data.arches[0] ?? ''),
        );
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Failed to load CPU architectures');
        }
      });
    return () => controller.abort();
  }, [open]);

  // Load the version listing whenever the arch changes.
  React.useEffect(() => {
    if (!open || !arch) {
      return;
    }
    const controller = new AbortController();
    setCatalog(null);
    setSelected(null);
    setImportedVersion(null);
    setPhase('idle');
    setIsLoading(true);
    fetchSupervisorVersionsForArch(arch, controller.signal)
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
  }, [open, arch]);

  const canImport = selected !== null && !selected.seeded && phase === 'idle';

  const importVersion = async (): Promise<void> => {
    if (!selected || !arch) {
      return;
    }

    setPhase('importing');
    setError(null);
    try {
      await importSupervisorVersion(arch, selected.version);
      setImportedVersion(selected.version);
      const controller = new AbortController();
      await fetchSupervisorVersionsForArch(arch, controller.signal).then((data) => setCatalog(data));
      setSelected(null);
      setPhase('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Supervisor import failed');
      setPhase('idle');
    }
  };

  const renderVersionLabel = (entry: SupervisorVersionEntry): React.ReactNode => (
    <Box component='span' sx={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <span>{entry.version}</span>
      {entry.seeded ? (
        <Chip size='small' color='success' variant='outlined' label='imported' />
      ) : (
        <Chip size='small' variant='outlined' label='available' />
      )}
    </Box>
  );

  return (
    <Dialog open={open} onClose={phase === 'importing' ? undefined : onClose} maxWidth='sm' fullWidth>
      <DialogTitle>Supervisor Versions</DialogTitle>
      <DialogContent>
        <Typography variant='body2' color='text.secondary' sx={{ mb: 1 }}>
          The supervisor depends only on the CPU architecture — imported versions are shared by every device type of
          that architecture and become selectable when updating a device&apos;s supervisor.
        </Typography>

        {arches.length > 0 && (
          <Select
            size='small'
            value={arch}
            onChange={(event) => setArch(event.target.value)}
            sx={{ mb: 1, minWidth: 160 }}
            disabled={phase === 'importing'}
          >
            {arches.map((entry) => (
              <MenuItem key={entry} value={entry}>
                {entry}
              </MenuItem>
            ))}
          </Select>
        )}

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
                <ListItemText primary='No supervisor versions found for this architecture' />
              </ListItemButton>
            )}
            {catalog.versions.map((entry) => {
              const selectable = !entry.seeded;
              return (
                <ListItemButton
                  key={entry.rawVersion}
                  disabled={!selectable}
                  selected={selected?.rawVersion === entry.rawVersion}
                  onClick={() => setSelected(entry)}
                >
                  <ListItemText
                    primary={renderVersionLabel(entry)}
                    secondary={entry.rawVersion !== entry.version ? `mirror tag: ${entry.rawVersion}` : undefined}
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
              Importing supervisor {selected?.version} for {arch}: mirroring image bytes into your registry…
            </Typography>
            <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
              {SUPERVISOR_IMPORT_HINT}
            </Typography>
          </Box>
        )}

        {phase !== 'importing' && importedVersion && (
          <Alert severity='success' sx={{ mt: 1 }}>
            supervisor {importedVersion} imported — it is now selectable when updating a device&apos;s supervisor.
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

export default SupervisorVersionsDialog;
