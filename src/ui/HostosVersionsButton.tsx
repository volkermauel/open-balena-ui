import React from 'react';
import { Button, ButtonProps, Tooltip } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import HostosVersionsDialog from './HostosVersionsDialog';

/**
 * Device type list row action: opens the hostOS version management dialog for
 * the device type (mirror catalog with import state + import action).
 */
export interface HostosVersionsButtonProps {
  deviceTypeSlug: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  disabled?: boolean;
}

export const HostosVersionsButton: React.FC<HostosVersionsButtonProps> = ({
  deviceTypeSlug,
  variant = 'outlined',
  size = 'small',
  disabled,
}) => {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Tooltip title='Manage the hostOS versions imported for this device type'>
        <span>
          <Button
            variant={variant}
            size={size}
            onClick={() => setOpen(true)}
            disabled={disabled}
            startIcon={<DownloadIcon />}
          >
            OS Versions
          </Button>
        </span>
      </Tooltip>
      <HostosVersionsDialog open={open} onClose={() => setOpen(false)} deviceTypeSlug={deviceTypeSlug} />
    </>
  );
};

export default HostosVersionsButton;
