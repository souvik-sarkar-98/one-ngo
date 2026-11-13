import type { GuideSection, StageRow, StageScreen } from './model';

const donations: StageRow[] = [
  { title: 'Asha Rao', meta: 'DON/2026-27/00041 · UPI', amount: '₹1,500.00', status: 'Raised' },
  { title: 'Ravi Kumar', meta: 'DON/2026-27/00040 · UPI', amount: '₹5,000.00', status: 'Raised' },
  { title: 'Meera Iyer', meta: 'DON/2026-27/00039 · UPI', amount: '₹750.00', status: 'Raised' },
  { title: 'Sunita Devi', meta: 'DON/2026-27/00038 · UPI', amount: '₹2,100.00', status: 'Raised' },
];

const donors: StageRow[] = [
  { title: 'Asha Rao', meta: 'asha@example.org · +91 98450 12301', status: 'Pune' },
  { title: 'Ravi Kumar', meta: 'ravi@example.org · +91 98450 12210', status: 'Chennai' },
  { title: 'Priya Nair', meta: 'priya@example.org · +91 98201 44552', status: 'Kochi' },
];

function donationList(patch: Partial<Extract<StageScreen, { kind: 'list' }>> = {}): StageScreen {
  return {
    kind: 'list',
    title: 'Donations',
    crumbs: ['Records', 'Fundraising', 'Donations'],
    chips: ['All', 'Mine', 'Outstanding', 'Closed'],
    chip: 'All',
    search: '',
    pills: [],
    rows: donations,
    nav: 'records',
    back: true,
    fab: true,
    ...patch,
  };
}

export const GUIDE: readonly GuideSection[] = [
  {
    id: 'app',
    label: 'App',
    icon: 'home',
    source: 'docs/design/wireframes/ngo-app-navigation-flows.html',
    chapters: [
      {
        id: 'sign-in',
        title: 'Sign in and land on Home',
        lead: 'The first open of the app or the website. After sign-in, Home shows one card per record group.',
        steps: [
          {
            title: 'Sign in',
            action: 'Open the organisation address and continue with the method that organisation allows.',
            path: '/o/demo/sign-in',
            mobile: 'The sign-in card uses the full width. Buttons stack.',
            web: 'The same card sits in the centre of the page. There is no app bar yet.',
            screen: { kind: 'signin', heading: 'Demo Foundation', detail: 'Sign in to NGOOne', action: 'Continue' },
          },
          {
            title: 'Home',
            action: 'After sign-in the inbox badge shows how many approvals are waiting.',
            path: '/',
            mobile: 'Group cards stack in one column. Navigation is the bottom bar: Home, Records, Inbox, More.',
            web: 'The same cards sit in the page. Navigation is a side rail with the same four items.',
            screen: {
              kind: 'home',
              greeting: 'Good morning, Asha',
              groups: [
                { name: 'Fundraising', types: ['Donors', 'Donations'] },
                { name: 'Other', types: ['Expenses'] },
              ],
            },
          },
        ],
      },
      {
        id: 'find',
        title: 'Find a donation',
        lead: 'Open a list, switch chip, search, filter and sort. Every change is in the address, so Back and a shared link restore it.',
        steps: [
          {
            title: 'Records, grouped',
            action: 'Tap Records. Groups stack in one column on every width.',
            path: '/records',
            mobile: 'Each record type is a row. There is no table.',
            web: 'The same single column. Wide screens do not place groups side by side.',
            screen: {
              kind: 'home',
              greeting: 'Records',
              groups: [
                { name: 'Fundraising', types: ['Donors', 'Donations'] },
                { name: 'Other', types: ['Expenses', 'Assets'] },
              ],
            },
          },
          {
            title: 'Donations list',
            action: 'Tap Donations. The list opens on its default chip.',
            path: '/records/donation',
            mobile: 'Rows are cards. The create button sits above the bottom bar.',
            web: 'Rows are a table. The Cards/Table switch is available. The create button sits at the bottom right.',
            screen: donationList(),
          },
          {
            title: 'Search, filter and sort',
            action: 'Type a name, apply Filters, then Sort by amount. The address keeps chip, query, filters and sort.',
            path: '/records/donation?chip=mine&q=ravi&method=upi&sort=-amount',
            mobile: 'Filter pills wrap under the toolbar. Sort is a menu. Cards stay cards.',
            web: 'The same pills and menu. Column headers sort the table as well, with the same arrow.',
            screen: donationList({ chip: 'Mine', search: 'ravi', pills: ['UPI', 'Amount from ₹100', 'Amount ▼'] }),
          },
        ],
      },
      {
        id: 'record',
        title: 'Open a donation and run a step',
        lead: 'A record always opens in the record panel. The panel is one column on every width.',
        steps: [
          {
            title: 'Open the record',
            action: 'Tap Ravi Kumar.',
            path: '/records/donation?id=40',
            mobile: 'The panel slides up from the bottom, up to the full height.',
            web: 'The same panel is centred, up to 720px wide. Fields stay in one column.',
            screen: {
              kind: 'panel',
              title: 'Donations',
              crumbs: ['Records', 'Fundraising', 'Donations', 'DON/2026-27/00040 · Ravi Kumar'],
              heading: 'Ravi Kumar',
              lines: [
                { label: 'Number', value: 'DON/2026-27/00040' },
                { label: 'Amount', value: '₹5,000.00' },
                { label: 'Status', value: 'Raised' },
              ],
              actions: ['Mark as paid', 'Edit'],
              nav: 'records',
            },
          },
          {
            title: 'Mark as paid',
            action: 'Tap Mark as paid. The step asks only for the fields it needs.',
            path: '/records/donation?id=40&panel=step:markPaid',
            mobile: 'The breadcrumb shows the first item, …, and the last item. Tapping … opens the full trail.',
            web: 'The breadcrumb shows the whole trail: Records, Fundraising, Donations, the record, then Mark as paid.',
            screen: {
              kind: 'panel',
              title: 'Donations',
              crumbs: ['Records', '…', 'Mark as paid'],
              heading: 'Mark as paid',
              lines: [{ label: 'Paid on', value: '1 Nov 2026' }],
              actions: ['Cancel', 'Mark as paid'],
              nav: 'records',
            },
          },
        ],
      },
      {
        id: 'edit',
        title: 'Edit a donation',
        lead: 'Edit uses the same panel. Hidden and locked fields follow the record state on every device.',
        steps: [
          {
            title: 'Edit form',
            action: 'Open the row menu and tap Edit, or open the record and tap Edit.',
            path: '/records/donation?id=41&panel=edit',
            mobile: 'The form is a bottom sheet. A problem is written under its field.',
            web: 'The same form is a centred panel. The wording of a problem is the same.',
            screen: {
              kind: 'panel',
              title: 'Donations',
              crumbs: ['Records', 'Fundraising', 'Donations', 'Edit'],
              heading: 'Asha Rao',
              lines: [
                { label: 'Donor email', value: 'asha@example.org' },
                { label: 'Amount', value: '₹1,500.00' },
              ],
              actions: ['Cancel', 'Save'],
              nav: 'records',
            },
          },
        ],
      },
      {
        id: 'create',
        title: 'Create a donation',
        lead: 'The create button and the stepper are the same on both. The steps come from the list view.',
        steps: [
          {
            title: 'Choose the donor',
            action: 'Tap +, type pri in Donor, then choose Priya Nair. Her details fill in and lock.',
            path: '/records/donation?create=new',
            mobile: 'The + sits above the bottom bar. The stepper is Step 1 of 2 inside the sheet.',
            web: 'The + sits at the bottom right. The same stepper is in the centred panel.',
            screen: {
              kind: 'panel',
              title: 'Donations',
              crumbs: ['Records', 'Fundraising', 'Donations', 'New donation'],
              heading: 'Donor · Step 1 of 2',
              lines: [
                { label: 'Donor', value: 'Priya Nair' },
                { label: 'Donor email', value: 'priya@example.org' },
              ],
              actions: ['Cancel', 'Next'],
              nav: 'records',
            },
          },
          {
            title: 'Details',
            action: 'Tap Next, enter the amount, then Create. The new donation is at the top of the list.',
            path: '/records/donation?create=new&createStep=1',
            mobile: 'Amount uses the same outlined field. The sheet footer holds Back and Create.',
            web: 'The same fields. Nothing is placed in a second column.',
            screen: {
              kind: 'panel',
              title: 'Donations',
              crumbs: ['Records', 'Fundraising', 'Donations', 'New donation'],
              heading: 'Details · Step 2 of 2',
              lines: [{ label: 'Amount', value: '₹2,500.00' }],
              actions: ['Back', 'Create'],
              nav: 'records',
            },
          },
        ],
      },
      {
        id: 'donors',
        title: 'Donors and their donations',
        lead: 'Donors are a record type in Fundraising. A donor record lists the donations that point at them.',
        steps: [
          {
            title: 'Donors list',
            action: 'Records, Fundraising, Donors.',
            path: '/records/donor',
            mobile: 'Each donor is a card with email and phone.',
            web: 'The table columns are name, email, phone and city.',
            screen: {
              kind: 'list',
              title: 'Donors',
              crumbs: ['Records', 'Fundraising', 'Donors'],
              chips: ['All'],
              chip: 'All',
              search: '',
              pills: [],
              rows: donors,
              nav: 'records',
              back: true,
              fab: true,
            },
          },
          {
            title: 'Donor record',
            action: 'Tap Ravi Kumar. The related Donations section shows the latest gifts and a total.',
            path: '/records/donor?id=d7',
            mobile: 'Related donations are rows in the bottom sheet.',
            web: 'The same section is in the centred panel, still one column.',
            screen: {
              kind: 'panel',
              title: 'Donors',
              crumbs: ['Records', 'Fundraising', 'Donors', 'Ravi Kumar'],
              heading: 'Ravi Kumar',
              lines: [
                { label: 'City', value: 'Chennai' },
                { label: 'Donations', value: '3 · ₹8,100.00' },
              ],
              actions: ['New donation for Ravi Kumar', 'Edit'],
              nav: 'records',
            },
          },
        ],
      },
      {
        id: 'inbox',
        title: 'Inbox: approvals and notifications',
        lead: 'Approvals and Notifications are chips. The badge on Inbox counts approvals waiting for you. Unread notifications are counted on their chip.',
        steps: [
          {
            title: 'Approvals',
            action: 'Tap Inbox. It opens on Approvals when anything is waiting, longest waiting first.',
            path: '/inbox?tab=approvals',
            mobile: 'Approval rows are cards, with Approve and Reject on the card.',
            web: 'The same rows are a table: record, type, step, status change, requested by, waiting since.',
            screen: {
              kind: 'inbox',
              tab: 'Approvals',
              badge: 4,
              rows: [
                { title: 'DON/2026-27/00040 · Ravi Kumar', meta: 'Mark as paid · Raised → Paid · Asha · 3 days', status: '0 / 1' },
                { title: 'EXP/2026-27/00007 · Field travel', meta: 'Approve claim · Submitted → Approved · Ravi · 2 days', status: '1 / 2' },
              ],
            },
          },
          {
            title: 'Notifications',
            action: 'Tap Notifications. Tapping one marks it read and opens its record.',
            path: '/inbox?tab=notifications',
            mobile: 'Unread rows stay stronger. Mark all read sits with the chip.',
            web: 'The same list. Read rows are dimmed on both.',
            screen: {
              kind: 'inbox',
              tab: 'Notifications',
              badge: 0,
              rows: [{ title: 'Receipt issued', meta: 'DON/2026-27/00040 · New', status: 'Unread' }],
            },
          },
        ],
      },
      {
        id: 'account',
        title: 'Account and sign out',
        lead: 'This is More when no navigation has been published. Sign out is on the initials in the app bar, with a confirmation that this device will be signed out.',
        steps: [
          {
            title: 'More',
            action: 'Tap More. The account card opens My profile. Record groups are not listed here.',
            path: '/more',
            mobile: 'More is a screen. The bottom bar highlights More.',
            web: 'The same screen beside the rail.',
            screen: {
              kind: 'more',
              account: 'Asha Sharma',
              detail: 'asha@demo.local · Demo Foundation',
              items: ['Fundraising dashboard', 'Administration', 'Language · English', 'About this app'],
            },
          },
        ],
      },
      {
        id: 'custom-nav',
        title: 'Custom navigation',
        lead: 'One published navigation chooses the bar, the rail and More. The phone bar keeps the first four slots, then More. Further items stay on the rail and at the top of More on a phone.',
        steps: [
          {
            title: 'A record list on the bar',
            action: 'Open Donations from the bar. The bar highlights Donations, not Records.',
            path: '/records/donation',
            mobile: 'The bar shows Home, Donors, Donations, Inbox, then More. Visits is not on the bar.',
            web: 'The rail also shows Visits. It can hold eight slots.',
            screen: donationList({ nav: 'donations' }),
          },
          {
            title: 'More over the current screen',
            action: 'Tap More. The address does not change. Close returns to the list.',
            path: '/records/donation',
            mobile: 'More is the existing bottom sheet. Visits, which did not fit on the bar, is the first tile.',
            web: 'More is a panel beside the rail, not a centred dialog. Items already on the rail are not repeated.',
            screen: {
              kind: 'more',
              account: 'More',
              detail: 'The donations list stays behind this menu',
              items: ['Visits', 'Fundraising dashboard', 'Administration', 'Settings'],
            },
          },
          {
            title: 'Settings',
            action: 'Tap Settings. My profile, Language and About this app live here, not as More tiles.',
            path: '/settings',
            mobile: 'Settings is its own screen. Back returns to the screen that was open before More.',
            web: 'The same screen. The rail does not gain a Settings item.',
            screen: {
              kind: 'more',
              account: 'Settings',
              detail: 'Opened from More',
              items: ['My profile', 'Language · English', 'About this app'],
            },
          },
        ],
      },
      {
        id: 'home',
        title: 'Home with widgets and pins',
        lead: 'Home can show counts, totals, charts, short lists and record groups. Pins are personal and sit above the organisation widgets.',
        steps: [
          {
            title: 'Home',
            action: 'Sign in, or tap Home. Numbers appear only in widgets someone configured.',
            path: '/',
            mobile: 'Widgets are one per row.',
            web: 'Widgets are two per row.',
            screen: {
              kind: 'home',
              greeting: 'Good morning, Asha',
              groups: [
                { name: 'Pinned · Mine, UPI', types: ['Donations · See all'] },
                { name: 'Fundraising', types: ['Donors', 'Donations'] },
              ],
            },
          },
        ],
      },
      {
        id: 'pages',
        title: 'A page from More',
        lead: 'Extra pages use the same widgets as Home. Only people in the page audience see them.',
        steps: [
          {
            title: 'Open the page',
            action: 'More, then Fundraising dashboard.',
            path: '/pages/fundraising',
            mobile: 'The page title has Back on its left. Widgets stack.',
            web: 'The same page. A published navigation can also put the page on the rail.',
            screen: {
              kind: 'home',
              greeting: 'Fundraising dashboard',
              groups: [{ name: 'This month', types: ['Donations received', 'Receipts issued'] }],
            },
          },
        ],
      },
      {
        id: 'language',
        title: 'Choose a language',
        lead: 'English, Hindi, Tamil, Telugu, Bengali and Marathi. The choice is saved on the membership and applies at once.',
        steps: [
          {
            title: 'Language',
            action: 'More, Language, then हिन्दी. Organisation labels use a translation where one exists.',
            path: '/more?panel=language',
            mobile: 'The language list is a bottom sheet over More.',
            web: 'The same list is a centred panel.',
            screen: {
              kind: 'panel',
              title: 'More',
              crumbs: ['More', 'Language'],
              heading: 'Language',
              lines: [
                { label: 'English', value: 'Current' },
                { label: 'हिन्दी', value: 'Hindi' },
              ],
              actions: ['Close'],
              nav: 'more',
            },
          },
        ],
      },
      {
        id: 'actions',
        title: 'Record actions',
        lead: 'Buttons such as Send reminder and Print receipt appear in the panel footer and the row menu when their condition and permission allow.',
        steps: [
          {
            title: 'Send reminder',
            action: 'Open Asha Rao, tap Send reminder, confirm, and return to the record with a message.',
            path: '/records/donation?id=41&panel=action:sendReminder',
            mobile: 'The action form is the bottom sheet. Confirmation uses that same sheet, not a browser prompt.',
            web: 'The same form and confirmation, centred.',
            screen: {
              kind: 'panel',
              title: 'Donations',
              crumbs: ['Records', 'Fundraising', 'Donations', 'Send reminder'],
              heading: 'Send reminder',
              lines: [{ label: 'Channel', value: 'Email' }],
              actions: ['Cancel', 'Send reminder'],
              nav: 'records',
            },
          },
        ],
      },
      {
        id: 'print',
        title: 'Print a receipt',
        lead: 'The receipt is its own page, laid out for paper. The browser print dialog can also save a PDF. Nothing is loaded from outside.',
        steps: [
          {
            title: 'Print receipt',
            action: 'On a paid donation, tap Print receipt.',
            path: '/print/receipt/40',
            mobile: 'There is no app bar. The page is the receipt.',
            web: 'The same page. Print uses the browser dialog on both.',
            screen: {
              kind: 'print',
              title: 'Receipt RCPT/2026-27/00012',
              lines: ['Demo Foundation', 'Ravi Kumar', '₹5,000.00', 'Paid 23 Oct 2026'],
            },
          },
        ],
      },
      {
        id: 'import',
        title: 'Import from CSV and export',
        lead: 'Import is a five-step panel: upload, match columns, check every row, run, then download failures. Export downloads the current list.',
        steps: [
          {
            title: 'Import',
            action: 'On the list menu, tap Import.',
            path: '/records/donation?panel=import',
            mobile: 'The stepper is a bottom sheet. Choose a file from the phone.',
            web: 'The same stepper, centred. A file can be dropped on the first step.',
            screen: {
              kind: 'panel',
              title: 'Donations',
              crumbs: ['Records', 'Fundraising', 'Donations', 'Import'],
              heading: 'Match columns · Step 2 of 5',
              lines: [
                { label: 'name', value: 'Donor name' },
                { label: 'amount', value: 'Amount' },
              ],
              actions: ['Back', 'Next'],
              nav: 'records',
            },
          },
        ],
      },
      {
        id: 'files',
        title: 'Files on a record',
        lead: 'A file field holds photos, PDFs and spreadsheets. Images and PDFs preview in the record panel.',
        steps: [
          {
            title: 'Add a file',
            action: 'On a beneficiary, add a document.',
            path: '/records/beneficiary?id=b3&panel=edit',
            mobile: 'Choose files, or Take photo with the camera. Progress shows on the row.',
            web: 'Drag files onto the field, or choose them. There is no camera button.',
            screen: {
              kind: 'form',
              title: 'Beneficiary',
              crumbs: ['Records', 'Beneficiary', 'Edit'],
              fields: [
                { label: 'Documents', value: 'id-proof.pdf · uploading' },
                { label: 'Hint', value: 'Images or PDF · up to 10 MB' },
              ],
              aside: 'On a phone the field offers Take photo. On a wide screen it offers a drop area.',
            },
          },
        ],
      },
      {
        id: 'share',
        title: 'Share a record',
        lead: 'For types limited to their own and shared records, share from the panel menu with read or edit access and an optional end date.',
        steps: [
          {
            title: 'Share',
            action: 'Open the record menu and tap Share.',
            path: '/records/beneficiary?id=b3&panel=share',
            mobile: 'The share form is a bottom sheet. Shared with me is a chip on the list.',
            web: 'The same form, centred.',
            screen: {
              kind: 'panel',
              title: 'Beneficiaries',
              crumbs: ['Records', 'Beneficiaries', 'Share'],
              heading: 'Share',
              lines: [
                { label: 'Person or role', value: 'Field team' },
                { label: 'Access', value: 'Edit' },
              ],
              actions: ['Cancel', 'Share'],
              nav: 'records',
            },
          },
        ],
      },
      {
        id: 'bulk',
        title: 'Select rows and act on many',
        lead: 'Select from the list menu, or long-press a card. The bulk bar offers steps allowed for every selected record. Selection is not part of the address.',
        steps: [
          {
            title: 'Selected',
            action: 'Select two donations, then Mark as paid.',
            path: '/records/donation',
            mobile: 'A checkbox appears on each card. The bar shows the count, the primary step, and a menu for the rest.',
            web: 'The table gains a checkbox column. The bar lists Mark as paid, Send reminder, Edit fields and Export.',
            screen: donationList({ pills: ['2 selected'] }),
          },
        ],
      },
      {
        id: 'fields',
        title: 'Location, signature and rich text',
        lead: 'Location can use this device or typed coordinates, with a link out to maps. Signature records who signed and when. Rich text has a small toolbar.',
        steps: [
          {
            title: 'Beneficiary fields',
            action: 'Edit a beneficiary and fill location, signature and notes.',
            path: '/records/beneficiary?id=b3&panel=edit',
            mobile: 'Use my location uses the phone. Sign with a finger.',
            web: 'The same fields. Sign with a mouse or pen. There is still no map inside the app.',
            screen: {
              kind: 'form',
              title: 'Beneficiary',
              crumbs: ['Records', 'Beneficiary', 'Edit'],
              fields: [
                { label: 'Location', value: '18.52, 73.86 · Use my location' },
                { label: 'Signature', value: 'Asha Sharma · 1 Nov 2026' },
                { label: 'Notes', value: 'Bold, lists and links' },
              ],
              aside: 'The same three fields. Width does not add a map.',
            },
          },
        ],
      },
      {
        id: 'workflows',
        title: 'A record with two workflows',
        lead: 'One workflow is chosen when the record is created. Another can run beside it. The panel shows one status line per workflow and groups the footer by workflow.',
        steps: [
          {
            title: 'Scholarship case',
            action: 'Open the case. Intake and closure each have their own steps.',
            path: '/records/case?id=c12',
            mobile: 'Status lines stack. Footer buttons sit in two columns.',
            web: 'The same lines and groups, in the centred panel. Buttons can sit in one row.',
            screen: {
              kind: 'panel',
              title: 'Cases',
              crumbs: ['Records', 'Cases', 'CASE/2026-27/00012'],
              heading: 'Scholarship · Lakshmi Devi',
              lines: [
                { label: 'Intake', value: 'Under review' },
                { label: 'Case closure', value: 'Open' },
              ],
              actions: ['Advance intake', 'Close case', 'Edit'],
              nav: 'records',
            },
          },
        ],
      },
      {
        id: 'people',
        title: 'Administration',
        lead: 'Administrators open Administration for people, roles and operations. What a role allows is defined in the Builder.',
        steps: [
          {
            title: 'Administration',
            action: 'More, Administration. Each area needs its own permission.',
            path: '/admin',
            mobile: 'Areas are grouped: Appearance, Organisation, People and roles, then Operations.',
            web: 'The same groups. Editors that need a wide screen stay in the Builder.',
            screen: {
              kind: 'more',
              account: 'Administration',
              detail: 'Demo Foundation',
              items: ['Theme', 'Layout', 'Organisation information', 'People', 'Roles', 'Connectors', 'API keys', 'Jobs', 'Audit log'],
            },
          },
        ],
      },
      {
        id: 'profile',
        title: 'My profile',
        lead: 'Everyone opens Settings from More. My profile is the account card: name, email and organisation.',
        steps: [
          {
            title: 'Account',
            action: 'Open Settings. The account card shows the name, email and organisation. An administrator changes the name and email.',
            path: '/settings',
            mobile: 'Settings is its own screen. The account card is the first group.',
            web: 'The same account card.',
            screen: {
              kind: 'form',
              title: 'My profile',
              crumbs: ['More', 'Settings'],
              fields: [
                { label: 'Name', value: 'Demo Admin' },
                { label: 'Email', value: 'admin@demo.local' },
                { label: 'Organisation', value: 'Demo Foundation' },
              ],
              aside: 'Your name and email are changed by an administrator.',
            },
          },
        ],
      },
    ],
  },
  {
    id: 'builder',
    label: 'Builder',
    icon: 'records',
    source: 'docs/design/wireframes/ngo-builder-screens.html',
    chapters: [
      {
        id: 'catalogue',
        title: 'Catalogue',
        lead: 'Everything that can be configured, in one list. Chips filter by kind. Search finds a name or a key.',
        steps: [
          {
            title: 'Builder home',
            action: 'Open Builder. Phones can review what is published. Editing is for a tablet or a computer.',
            path: '/builder',
            mobile: 'The catalogue is read-only. A note says editing works best on a larger screen.',
            web: 'The catalogue is a table with owner and state. New, Modules, and Roles & access are available.',
            screen: { kind: 'builder', title: 'Builder', body: 'Record types, workflows, list views, pages, actions and the theme. v2 published.' },
          },
        ],
      },
      {
        id: 'record-type',
        title: 'Record type, workflow and list',
        lead: 'A record type names the fields. A workflow draws the states and steps. A list view sets chips, columns, the panel and the create form, with a live preview of phone and desktop.',
        steps: [
          {
            title: 'Donation',
            action: 'Open the Donation record type, then its workflow and its list view.',
            path: '/builder/recordTypes/donation',
            mobile: 'You can read the published definition. Dragging fields and publishing stay on a larger screen.',
            web: 'Fields are a reorderable table. The list view preview shows the phone and the desktop together.',
            screen: { kind: 'builder', title: 'Donation', body: 'Fields, rules, workflow steps, list columns and create steps. Changes publish as a new version.' },
          },
        ],
      },
      {
        id: 'groups',
        title: 'Record groups and navigation',
        lead: 'Groups arrange Home and Records. Navigation arranges the bar and the rail. Both are published definitions. An administrator can also change navigation from Administration without opening the Builder.',
        steps: [
          {
            title: 'Arrange',
            action: 'Builder, Record groups or Navigation, then Publish.',
            path: '/builder/navigation/app',
            mobile: 'The published order is visible. The first four sidebar slots are the phone bar. Arranging is disabled.',
            web: 'Two columns: sidebar (up to eight) and More. Home stays on the sidebar. Settings stays a More tile.',
            screen: { kind: 'builder', title: 'Navigation', body: 'Sidebar: Home, Donors, Donations, Inbox, Visits. More: pages, Administration, Builder, Settings.' },
          },
        ],
      },
    ],
  },
  {
    id: 'sign-in',
    label: 'Sign-in',
    icon: 'people',
    source: 'docs/design/wireframes/release-2-sign-in-wireframe.html',
    chapters: [
      {
        id: 'organisation',
        title: 'The organisation is the address',
        lead: 'Each organisation has its own sign-in page at /o/<code>/sign-in. The generic page only asks for the organisation code, then opens that page.',
        steps: [
          {
            title: 'Organisation code',
            action: 'At /sign-in, enter the organisation code.',
            path: '/sign-in',
            mobile: 'One card, full width.',
            web: 'The same card, centred.',
            screen: { kind: 'signin', heading: 'NGOOne', detail: 'Organisation code', action: 'Continue' },
          },
          {
            title: 'That organisation',
            action: 'The page shows the organisation name and logo, and only the methods it allows.',
            path: '/o/demo/sign-in',
            mobile: 'Password and code are tabs. A provider button is full width under the card.',
            web: 'The same tabs and button, still a single card.',
            screen: { kind: 'signin', heading: 'Demo Foundation', detail: 'Password or one-time code', action: 'Sign in' },
          },
        ],
      },
      {
        id: 'recovery',
        title: 'Reset and the authenticator',
        lead: 'Forgot password, the emailed code, and an authenticator step replace the tabs. They take the whole card.',
        steps: [
          {
            title: 'Reset',
            action: 'Ask for a reset link, set a password, then return to the organisation sign-in page.',
            path: '/reset-password',
            mobile: 'The reset card has no app bar and no bottom navigation.',
            web: 'The same card. Sign-in, reset and print are the screens without the shell.',
            screen: { kind: 'signin', heading: 'Set a new password', detail: 'Then return to Demo Foundation', action: 'Save password' },
          },
        ],
      },
    ],
  },
  {
    id: 'organisation',
    label: 'Org',
    icon: 'settings',
    source: 'docs/design/wireframes/org-admin-appearance.html',
    chapters: [
      {
        id: 'information',
        title: 'Organisation information',
        lead: 'An administrator with Manage organisation settings edits the name, legal name, contact, address, registrations and logo. The code and the sign-in link are read-only.',
        steps: [
          {
            title: 'Identity',
            action: 'Administration, Organisation information. Save writes an audit row.',
            path: '/admin/settings',
            mobile: 'The form is one column.',
            web: 'The form sits beside a live preview of the app bar and a receipt heading.',
            screen: {
              kind: 'form',
              title: 'Organisation information',
              crumbs: ['More', 'Administration', 'Organisation information'],
              fields: [
                { label: 'Name', value: 'Demo Foundation' },
                { label: 'Legal name', value: 'Demo Foundation' },
                { label: 'Code', value: 'demo · read-only' },
                { label: 'Logo', value: 'PNG, JPEG or WebP · at most 1 MB' },
              ],
              aside: 'The logo is shown on the app bar, the sign-in page and new receipts. A remote address is not loaded.',
            },
          },
        ],
      },
      {
        id: 'theme',
        title: 'Theme',
        lead: 'Brand, text, background, surface, lines and corner radius are tokens. A contrast check runs before publish. Failing contrast needs a confirmation.',
        steps: [
          {
            title: 'Colours',
            action: 'Administration, Theme. Publish. Everyone sees it on the next screen load, including sign-in.',
            path: '/admin/theme',
            mobile: 'Swatches and the preview stack.',
            web: 'The tokens are beside a preview of the real controls.',
            screen: {
              kind: 'form',
              title: 'Theme',
              crumbs: ['More', 'Administration', 'Theme'],
              fields: [
                { label: 'Brand', value: '#1f5f8b' },
                { label: 'Background', value: '#f5f7fa' },
                { label: 'Radius', value: '6px' },
              ],
              aside: 'Builder → Theme edits the same published theme.',
            },
          },
        ],
      },
      {
        id: 'layout',
        title: 'Layout',
        lead: 'The published navigation, plus the starting list layout on wide screens. Phones stay on cards. A person can still switch cards or table; that choice stays in the address.',
        steps: [
          {
            title: 'Navigation and lists',
            action: 'Administration, Layout. Put Donors and Donations on the sidebar, and choose Table as the starting wide layout.',
            path: '/admin/layout',
            mobile: 'You see the phone cutoff: the first four sidebar slots, then More. Arranging the order is the same list.',
            web: 'The rail preview includes the slots past the fourth. The starting layout control offers Cards or Table.',
            screen: {
              kind: 'form',
              title: 'Layout',
              crumbs: ['More', 'Administration', 'Layout'],
              fields: [
                { label: 'Sidebar', value: 'Home, Donors, Donations, Inbox, Visits, People' },
                { label: 'Wide lists start as', value: 'Table' },
              ],
              aside: 'Phones stay on cards. Publishing replaces the bar and More for this organisation.',
            },
          },
        ],
      },
    ],
  },
  {
    id: 'connectors',
    label: 'Connectors',
    icon: 'search',
    source: 'docs/architecture/connector-runtime.html',
    chapters: [
      {
        id: 'shape',
        title: 'Shape',
        lead: 'Callers name a connector key and a binding. They never open a socket. The runtime renders the request, calls HTTPS, and either queues a delivery or writes mapped fields back onto the record.',
        steps: [
          {
            title: 'One runtime',
            action: 'Use an http connector for a new customer integration. Existing sms, whatsapp and webhook rows keep working.',
            path: '/admin/connectors',
            mobile: 'The explanation stacks: callers, then the runtime, then the outside API.',
            web: 'The same three columns sit in a row: callers, runtime, outside.',
            screen: {
              kind: 'lanes',
              title: 'Connector runtime',
              lanes: [
                { name: 'Callers', steps: ['Automation action', 'Script effect', 'Notification', 'Record save'] },
                { name: 'Runtime', steps: ['Template', 'Planner', 'Caller', 'Binder', 'OAuth store', 'Delivery log'] },
                { name: 'Outside', steps: ['Customer HTTPS API', 'OAuth provider'] },
              ],
            },
          },
        ],
      },
      {
        id: 'send',
        title: 'Send',
        lead: 'After the record commits. An outbox event connector.http is retried up to five times. A failed call does not undo the donation.',
        steps: [
          {
            title: 'After commit',
            action: 'An automation, script or notification enqueues the binding in the same transaction as the record. The dispatcher renders and calls.',
            path: '/admin/connectors/slack',
            mobile: 'The save lane and the dispatcher lane stack.',
            web: 'The two lanes sit one under the other at full width, each step in a row.',
            screen: {
              kind: 'lanes',
              title: 'Send',
              lanes: [
                { name: 'Save transaction', steps: ['Enqueue connector.http with the binding. No secret and no rendered URL.'] },
                { name: 'Dispatcher', steps: ['Load the connector', 'Render the request', 'Call HTTPS', 'Log sent, pending or failed'] },
              ],
            },
          },
        ],
      },
      {
        id: 'lookup',
        title: 'Lookup',
        lead: 'During the save, before the write. The HTTP call is outside the database transaction. A non-success answer refuses the save. A lookup cannot be used as a send.',
        steps: [
          {
            title: 'Before the write',
            action: 'A field group names the connector and the inputs it may read. Mapped JSON paths are copied onto the record, then the normal save runs.',
            path: '/admin/connectors/ifsc',
            mobile: 'The before-write lane stacks above the save lane.',
            web: 'The same two lanes, with room for the full step text.',
            screen: {
              kind: 'lanes',
              title: 'Lookup',
              lanes: [
                { name: 'Before the write', steps: ['Read named inputs', 'Call with no row lock', 'Map JSON paths to fields'] },
                { name: 'Save transaction', steps: ['Merge and commit with the version check', 'A refusal is logged and is not retried'] },
              ],
            },
          },
        ],
      },
      {
        id: 'oauth',
        title: 'OAuth and the rules',
        lead: 'An oauth connector stores the refresh token encrypted. The caller refreshes when the access token is inside a minute of expiry. Templates may use record fields, secrets and the access token. An unknown placeholder is refused.',
        steps: [
          {
            title: 'Credential',
            action: 'Connect the provider once. Later calls only name the connector.',
            path: '/admin/connectors/google',
            mobile: 'The token steps stack.',
            web: 'The same steps in one lane.',
            screen: {
              kind: 'lanes',
              title: 'OAuth',
              lanes: [
                { name: 'Credential', steps: ['Authorization code', 'Refresh token in secret_enc', 'Access token refreshed near expiry'] },
                { name: 'Caller rules', steps: ['HTTPS only', 'No redirects', 'Public addresses only', 'Timeout defaults to 8 seconds'] },
              ],
            },
          },
        ],
      },
    ],
  },
];
