/** The person or key a permission check is about. */
export interface Actor {
  id: string;
  roles: string[];
  permissions: string[];
}
