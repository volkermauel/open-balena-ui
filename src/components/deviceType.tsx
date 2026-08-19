import * as React from 'react';
import {
  Create,
  Datagrid,
  DeleteButton,
  Edit,
  EditButton,
  List,
  ReferenceField,
  TopToolbar,
  ReferenceInput,
  ReferenceManyField,
  SelectInput,
  SimpleForm,
  SingleFieldList,
  TextField,
  TextInput,
  Toolbar,
  required,
  useRecordContext,
} from 'react-admin';
import { useCreateDeviceType } from '../lib/deviceType';
import HostosVersionsButton from '../ui/HostosVersionsButton';
import SupervisorVersionsButton from '../ui/SupervisorVersionsButton';
import Row from '../ui/Row';
import versions from '../versions';
import environment from '../lib/reactAppEnv';

const deviceTypeAlias = versions.resource('deviceTypeAlias', environment.REACT_APP_OPEN_BALENA_API_VERSION);

/** Row-level hostOS version management action bound to the row's device type slug. */
const HostosVersionsRowButton: React.FC = () => {
  const record = useRecordContext<{ id: number | string; slug: string }>();
  return record?.slug ? <HostosVersionsButton deviceTypeSlug={record.slug} /> : null;
};

/** Toolbar of the device types page: the arch-scoped supervisor import lives
 * here (not per device-type row) because the supervisor is arch-dependent only. */
const DeviceTypeListActions: React.FC = () => (
  <TopToolbar>
    <SupervisorVersionsButton />
  </TopToolbar>
);

export const DeviceTypeList: React.FC = () => {
  return (
    <List actions={<DeviceTypeListActions />}>
      <Datagrid size='medium' rowClick={false}>
        <TextField label='Slug' source='slug' />
        <TextField label='Name' source='name' />

        <ReferenceField
          label='CPU Architecture'
          source='is of-cpu architecture'
          reference='cpu architecture'
          target='id'
        >
          <TextField source='slug' />
        </ReferenceField>

        {deviceTypeAlias ? (
          <ReferenceManyField label='Alias' source='id' reference={deviceTypeAlias} target='device type'>
            <SingleFieldList>
              <TextField source='is referenced by-alias' />
            </SingleFieldList>
          </ReferenceManyField>
        ) : (
          <></>
        )}

        <ReferenceField label='Device Family' source='belongs to-device family' reference='device family' target='id'>
          <TextField source='slug' />
        </ReferenceField>

        <Toolbar>
          <HostosVersionsRowButton />
          <EditButton label='' size='small' variant='outlined' />
          <DeleteButton mutationMode='optimistic' label='' size='small' variant='outlined' />
        </Toolbar>
      </Datagrid>
    </List>
  );
};

export const DeviceTypeCreate: React.FC = () => {
  const createDeviceType = useCreateDeviceType();

  return (
    <Create title='Create Device Type' redirect='list' transform={createDeviceType}>
      <SimpleForm>
        <Row>
          <TextInput source='slug' size='large' />
          <TextInput source='name' size='large' />
        </Row>

        <Row>
          <ReferenceInput
            label='CPU Architecture'
            source='is of-cpu architecture'
            reference='cpu architecture'
            target='id'
            perPage={1000}
            sort={{ field: 'slug', order: 'ASC' }}
          >
            <SelectInput optionText='slug' optionValue='id' validate={required()} />
          </ReferenceInput>

          <ReferenceInput
            label='Device Family'
            source='belongs to-device family'
            reference='device family'
            target='id'
            perPage={1000}
            sort={{ field: 'slug', order: 'ASC' }}
            allowEmpty
          >
            <SelectInput optionText='slug' optionValue='id' />
          </ReferenceInput>
        </Row>
      </SimpleForm>
    </Create>
  );
};

export const DeviceTypeEdit: React.FC = () => (
  <Edit title='Edit Device Type'>
    <SimpleForm>
      <Row>
        <TextInput source='slug' size='large' />
        <TextInput source='name' size='large' />
      </Row>

      <Row>
        <ReferenceInput
          label='CPU Architecture'
          source='is of-cpu architecture'
          reference='cpu architecture'
          target='id'
          perPage={1000}
          sort={{ field: 'slug', order: 'ASC' }}
        >
          <SelectInput optionText='slug' optionValue='id' validate={required()} />
        </ReferenceInput>

        <ReferenceInput
          label='Device Family'
          source='belongs to-device family'
          reference='device family'
          target='id'
          perPage={1000}
          sort={{ field: 'slug', order: 'ASC' }}
          allowEmpty
        >
          <SelectInput optionText='slug' optionValue='id' />
        </ReferenceInput>
      </Row>
    </SimpleForm>
  </Edit>
);

const deviceType = {
  list: DeviceTypeList,
  create: DeviceTypeCreate,
  edit: DeviceTypeEdit,
};

export default deviceType;
