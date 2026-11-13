/**
 * The contract interfaces only, for the web app. Type exports are erased when
 * compiled, so the web bundle gets none of the schemas, Ajv or server code.
 * Privacy is left out: its requests are typed from the privacy service.
 */
export type { CreateApiKeyRequest, ApiKeyView, CreatedApiKey, ApiKeyFeedChoice } from './api-keys.js';
export type { ApprovalQueryRequest, ApprovalDecisionRequest } from './approvals.js';
export type {
  LoginRequest,
  EmailRequest,
  EmailCodeVerifyRequest,
  PasswordResetCompleteRequest,
  TwoStepCompleteRequest,
  TwoStepConfirmRequest,
  TokenResponse,
} from './auth.js';
export type { ConnectorView, ConnectorSummary, ConnectorTestRequest, ConnectorOauthStartResponse } from './connectors.js';
export type { DraftRequest, ExtensionPatchRequest, RollbackRequest } from './definitions.js';
export type { FieldIssue, ErrorResponse } from './errors.js';
export type { RazorpayCredentialsRequest, CashfreeCredentialsRequest, GatewaySummary } from './gateways.js';
export type { AddMemberRequest, MemberRolesRequest } from './members.js';
export type { OpenAccountRequest, TransferRequest, CreatePaymentRequest, ConfirmPaymentRequest, StatementMatchRequest } from './money.js';
export type { OrganisationProfileRequest, RegistrationRequest } from './organisation.js';
export type {
  CreateRecordRequest,
  UpdateRecordRequest,
  TransitionRequest,
  ActionRequest,
  FieldFilterRequest,
  RecordQueryRequest,
  AggregateRequestBody,
  BulkOperationRequest,
  BulkRequest,
} from './records.js';
export type { CreateRoleRequest, UpdateRoleRequest, RoleMembersRequest } from './roles.js';
export type { SettingsRequest } from './settings.js';
