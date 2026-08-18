import React from 'react';
import { Button, ButtonProps, Tooltip } from '@mui/material';
import SystemUpdateAltIcon from '@mui/icons-material/SystemUpdateAlt';
import { Identifier, useDataProvider, useNotify } from 'react-admin';
import type { DataProvider } from 'react-admin';
import SupervisorUpdateDialog from './SupervisorUpdateDialog';
import { isDowngrade } from '../lib/supervisorRelease';

/**
 * Buttons that open the SupervisorUpdateDialog:
 *
 * - `SupervisorUpdateButton` — one device (or pre-resolved ids sharing a type)
 * - `SupervisorBulkUpdateButton` — react-admin bulk selection (must share one device type)
 * - `SupervisorFleetUpdateButton` — every device of a fleet, grouped by device type
 */

interface DeviceTypeGroup {
  deviceTypeId: number;
  deviceIds: number[];
  currentVersion: string | null;
}

/** Group device records by their device type and pick the lowest reported supervisor version per group. */
export const groupDevicesByDeviceType = (
  devices: { 'id': number | string; 'is of-device type'?: number; 'supervisor version'?: string | null }[],
): DeviceTypeGroup[] => {
  const groups = new Map<number, DeviceTypeGroup & { versions: string[] }>();
  for (const device of devices) {
    const deviceTypeId = device['is of-device type'];
    if (typeof deviceTypeId !== 'number') {
      continue;
    }
    const group = groups.get(deviceTypeId) ?? { deviceTypeId, deviceIds: [], currentVersion: null, versions: [] };
    group.deviceIds.push(Number(device.id));
    if (device['supervisor version']) {
      group.versions.push(device['supervisor version']);
    }
    groups.set(deviceTypeId, group);
  }

  return [...groups.values()].map(({ versions, ...group }) => ({
    ...group,
    // Most conservative current version: anything below the fleet minimum is a downgrade for at least one device.
    currentVersion: versions.reduce<string | null>(
      (lowest, version) => (lowest === null || isDowngrade(version, lowest) ? version : lowest),
      null,
    ),
  }));
};

const resolveDeviceTypeSlug = async (dataProvider: DataProvider, deviceTypeId: number): Promise<string | null> => {
  const { data } = await dataProvider.getOne<{ id: number; slug: string }>('device type', { id: deviceTypeId });
  return data?.slug ?? null;
};

/** Warn when devices had to be skipped because they lack a device type. */
const notifySkippedDevices = (
  total: number,
  groups: DeviceTypeGroup[],
  notify: (message: string, options: { type: 'info' | 'warning' | 'error' }) => void,
): void => {
  const grouped = groups.reduce((count, group) => count + group.deviceIds.length, 0);
  const skipped = total - grouped;
  if (skipped > 0) {
    notify(`${skipped} device(s) skipped — no device type on record`, { type: 'warning' });
  }
};

export interface SupervisorUpdateButtonProps {
  deviceIds: number[];
  deviceTypeSlug?: string;
  deviceTypeId?: number;
  currentVersion?: string | null;
  title?: string;
  label?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  sx?: ButtonProps['sx'];
  style?: React.CSSProperties;
  disabled?: boolean;
  /** Called after a successful apply, so parents can refresh stale state. */
  onUpdated?: () => void;
}

export const SupervisorUpdateButton: React.FC<SupervisorUpdateButtonProps> = ({
  deviceIds,
  deviceTypeSlug,
  deviceTypeId,
  currentVersion,
  title,
  label = 'Update Supervisor',
  variant = 'outlined',
  size,
  sx,
  style,
  disabled,
  onUpdated,
}) => {
  const dataProvider = useDataProvider<DataProvider>();
  const notify = useNotify();
  const [open, setOpen] = React.useState(false);
  const [slug, setSlug] = React.useState<string | null>(deviceTypeSlug ?? null);
  const [busy, setBusy] = React.useState(false);

  const openDialog = async (): Promise<void> => {
    let targetSlug = deviceTypeSlug ?? null;
    if (!targetSlug && deviceTypeId !== undefined) {
      setBusy(true);
      try {
        targetSlug = await resolveDeviceTypeSlug(dataProvider, deviceTypeId);
      } catch {
        targetSlug = null;
      } finally {
        setBusy(false);
      }
    }

    if (!targetSlug) {
      notify('Unable to resolve the device type for the supervisor update', { type: 'error' });
      return;
    }

    setSlug(targetSlug);
    setOpen(true);
  };

  if (deviceIds.length === 0) {
    return null;
  }

  return (
    <>
      <Tooltip title='Update the supervisor version targeted for these devices'>
        <span>
          <Button
            variant={variant}
            size={size}
            sx={sx}
            style={style}
            onClick={openDialog}
            disabled={disabled || busy}
            startIcon={<SystemUpdateAltIcon />}
          >
            {label}
          </Button>
        </span>
      </Tooltip>
      {slug && (
        <SupervisorUpdateDialog
          open={open}
          onClose={() => setOpen(false)}
          deviceTypeSlug={slug}
          currentVersion={currentVersion}
          deviceIds={deviceIds}
          title={title}
          onUpdated={onUpdated}
        />
      )}
    </>
  );
};

export interface SupervisorBulkUpdateButtonProps {
  selectedIds: Identifier[];
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}

export const SupervisorBulkUpdateButton: React.FC<SupervisorBulkUpdateButtonProps> = ({
  selectedIds,
  variant = 'outlined',
  size = 'small',
}) => {
  const dataProvider = useDataProvider<DataProvider>();
  const notify = useNotify();
  const [busy, setBusy] = React.useState(false);
  const [target, setTarget] = React.useState<{ slug: string; ids: number[]; currentVersion: string | null } | null>(
    null,
  );

  const openDialog = async (): Promise<void> => {
    setBusy(true);
    try {
      const { data: devices } = await dataProvider.getMany<{
        'id': number;
        'is of-device type'?: number;
        'supervisor version'?: string | null;
      }>('device', { ids: selectedIds.map((id) => Number(id)) });

      const groups = groupDevicesByDeviceType(devices as never[]);
      notifySkippedDevices(devices.length, groups, notify);
      if (groups.length !== 1) {
        notify('Select devices of a single device type to update their supervisor', { type: 'warning' });
        return;
      }

      const slug = await resolveDeviceTypeSlug(dataProvider, groups[0].deviceTypeId);
      if (!slug) {
        notify('Unable to resolve the device type for the supervisor update', { type: 'error' });
        return;
      }

      setTarget({ slug, ids: groups[0].deviceIds, currentVersion: groups[0].currentVersion });
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Failed to load selected devices', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (selectedIds.length === 0) {
    return null;
  }

  return (
    <>
      <Tooltip title='Update the supervisor for all selected devices (single device type only)'>
        <span>
          <Button
            variant={variant}
            size={size}
            onClick={openDialog}
            disabled={busy}
            startIcon={<SystemUpdateAltIcon />}
          >
            Update Supervisor
          </Button>
        </span>
      </Tooltip>
      {target && (
        <SupervisorUpdateDialog
          open
          onClose={() => setTarget(null)}
          deviceTypeSlug={target.slug}
          currentVersion={target.currentVersion}
          deviceIds={target.ids}
          title='Update Supervisor — Selected Devices'
        />
      )}
    </>
  );
};

export interface SupervisorFleetUpdateButtonProps {
  fleetId: number | string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  sx?: ButtonProps['sx'];
}

export const SupervisorFleetUpdateButton: React.FC<SupervisorFleetUpdateButtonProps> = ({
  fleetId,
  variant = 'outlined',
  size = 'large',
}) => {
  const dataProvider = useDataProvider<DataProvider>();
  const notify = useNotify();
  const [busy, setBusy] = React.useState(false);
  // Dialog queue: fleets normally span one device type; if several, run them one after another.
  const [queue, setQueue] = React.useState<{ slug: string; ids: number[]; currentVersion: string | null }[]>([]);

  const openDialog = async (): Promise<void> => {
    setBusy(true);
    try {
      const devices: {
        'id': number;
        'is of-device type'?: number;
        'supervisor version'?: string | null;
      }[] = [];

      let page = 1;
      for (;;) {
        const result = await dataProvider.getList<{
          'id': number;
          'is of-device type'?: number;
          'supervisor version'?: string | null;
        }>('device', {
          pagination: { page, perPage: 1000 },
          sort: { field: 'id', order: 'ASC' },
          filter: { 'belongs to-application': fleetId },
        });
        devices.push(...result.data);
        const total = result.total ?? devices.length;
        if (devices.length >= total || result.data.length === 0) {
          break;
        }
        page += 1;
      }

      if (devices.length === 0) {
        notify('This fleet has no devices', { type: 'info' });
        return;
      }

      const groups = groupDevicesByDeviceType(devices as never[]);
      notifySkippedDevices(devices.length, groups, notify);
      const entries: { slug: string; ids: number[]; currentVersion: string | null }[] = [];
      for (const group of groups) {
        const slug = await resolveDeviceTypeSlug(dataProvider, group.deviceTypeId);
        if (slug) {
          entries.push({ slug, ids: group.deviceIds, currentVersion: group.currentVersion });
        }
      }

      if (entries.length === 0) {
        notify('Unable to resolve the device types of this fleet', { type: 'error' });
        return;
      }

      setQueue(entries);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Failed to load fleet devices', { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const current = queue[0] ?? null;

  return (
    <>
      <Tooltip
        title={
          queue.length > 1
            ? `Updating fleet devices (${queue.length} device types, one dialog per type)`
            : 'Update the supervisor for all devices of this fleet'
        }
      >
        <span>
          <Button
            variant={variant}
            size={size}
            onClick={openDialog}
            disabled={busy}
            startIcon={<SystemUpdateAltIcon />}
          >
            Update Supervisor
          </Button>
        </span>
      </Tooltip>
      {current && (
        <SupervisorUpdateDialog
          open
          onClose={() => setQueue((items) => items.slice(1))}
          deviceTypeSlug={current.slug}
          currentVersion={current.currentVersion}
          deviceIds={current.ids}
          title='Update Supervisor — Fleet Devices'
        />
      )}
    </>
  );
};

export default SupervisorUpdateButton;
