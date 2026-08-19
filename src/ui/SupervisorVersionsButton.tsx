import React from 'react';
import { Button, ButtonProps, Tooltip } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import SupervisorVersionsDialog from './SupervisorVersionsDialog';

/**
 * List-level action for the device types page: opens the arch-scoped
 * supervisor version import dialog. The supervisor depends only on the CPU
 * architecture, so this is deliberately NOT a per-device-type row action.
 */
export interface SupervisorVersionsButtonProps {
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  disabled?: boolean;
}

export const SupervisorVersionsButton: React.FC<SupervisorVersionsButtonProps> = ({
  variant = 'outlined',
  size = 'small',
  disabled,
}) => {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Tooltip title='Import supervisor versions per CPU architecture (shared by all device types of that architecture)'>
        <span>
          <Button
            variant={variant}
            size={size}
            onClick={() => setOpen(true)}
            disabled={disabled}
            startIcon={<DownloadIcon />}
          >
            Supervisor Versions
          </Button>
        </span>
      </Tooltip>
      <SupervisorVersionsDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
};

export default SupervisorVersionsButton;
