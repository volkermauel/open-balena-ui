# os-download-mixed-fleets — spec delta

## MODIFIED Requirements

### Requirement: Fleet entry point

The UI SHALL offer a "Download OS" action on fleets that opens the provisioning wizard with the fleet selected and
present in the fleet dropdown immediately, its device type chosen as the default, and the fleet dropdown listing all
fleets. The fleet and device-type selections SHALL be independent: changing the device type SHALL NOT alter the fleet
selection, so that fleets with mixed device types can provision images for any of their device types.

#### Scenario: Launch from fleet

- **WHEN** the user triggers "Download OS" on a fleet
- **THEN** the wizard opens with that fleet selected and visible in the dropdown, and its device type chosen as the
  default

#### Scenario: Fleet list resilient to API filter gaps

- **WHEN** the application list request fails or returns no additional fleets
- **THEN** the launching fleet remains selected and selectable in the dropdown

#### Scenario: Mixed-device-type fleet

- **WHEN** the user changes the device type while a fleet is selected
- **THEN** the fleet selection remains unchanged and all fleets remain listed
