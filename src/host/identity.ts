// Who this machine's History belongs to, for events_list: the account its events name and the owner Memory binds.
import { hostname, userInfo } from "node:os"
import type { EventsOwner } from "./events-list.js"

/**
 * History reads only the local engine's sessions, so its source account is this machine and its owner is the OS user
 * who runs OpenCode here. Memory binds the pair once, when the person turns the source on, and refuses events from
 * any other owner.
 */
export interface LocalIdentity {
  /** The machine's host name as a slug, such as `studio-mac`: one History source per machine. */
  readonly account: string
  /** `os-user:<user>@<account>`, labelled `<user> on <account>`. */
  readonly owner: EventsOwner
}

const slug = (text: string, max: number) => text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, max)

/** The identity for an OS user and host name, as given. */
export function identityOf(user: string, host: string): LocalIdentity {
  const account = slug(host.replace(/\.local\.?$/i, ""), 63) || "local"
  const name = slug(user, 64) || "user"
  return { account, owner: { id: `os-user:${name}@${account}`, label: `${name} on ${account}` } }
}

/** This process's OS user and host name. A user without a password entry, as in some containers, falls back to $USER. */
export function localIdentity(): LocalIdentity {
  let user: string
  try {
    user = userInfo().username
  } catch {
    user = process.env["USER"] ?? process.env["LOGNAME"] ?? ""
  }
  return identityOf(user, hostname())
}
