import DownloadIcon from '@mui/icons-material/Download';
import { Button, ButtonProps } from '@mui/material';
import React, { useState } from 'react';
import { useRecordContext } from 'react-admin';
import type { ResourceRecord } from '../types/resource';
import OsDownloadDialog from './OsDownloadDialog';

interface FleetDownloadOsButtonProps {
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  sx?: ButtonProps['sx'];
  children?: React.ReactNode;
}

/**
 * "Download OS" action for fleet rows: opens the provisioning wizard with the fleet and its
 * device type preselected (fleet records reference device types via `is for-device type`).
 */
export const FleetDownloadOsButton: React.FC<FleetDownloadOsButtonProps> = ({ variant, size, sx, children }) => {
  const [open, setOpen] = useState(false);
  const record = useRecordContext<ResourceRecord>();

  return (
    <>
      <Button onClick={() => setOpen(true)} variant={variant} size={size} sx={sx}>
        <DownloadIcon
          sx={{ mr: '4px' }}
          fontSize={size === 'small' ? 'small' : size === 'large' ? 'large' : 'medium'}
        />{' '}
        {children}
      </Button>

      {record && (
        <OsDownloadDialog
          open={open}
          onClose={() => setOpen(false)}
          initialFleetId={record.id as string | number}
          initialFleetRecord={record}
          initialDeviceTypeId={record['is for-device type'] as string | number}
        />
      )}
    </>
  );
};

export default FleetDownloadOsButton;
