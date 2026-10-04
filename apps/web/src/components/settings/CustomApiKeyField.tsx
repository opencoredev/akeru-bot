import type { ProviderInstanceEnvironmentVariable } from "@akeru/contracts";

import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";

function KeyLabel(props: { readonly required: boolean }) {
  return (
    <span className="text-xs font-medium text-foreground">
      API key{" "}
      {props.required ? null : <span className="font-normal text-muted-foreground">optional</span>}
    </span>
  );
}

/** Key field for a Custom API instance that is not saved yet. */
export function CustomApiKeyDraftField(props: {
  readonly id: string;
  readonly value: string;
  readonly hint: string;
  readonly required: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label htmlFor={props.id} className="grid gap-1.5">
      <KeyLabel required={props.required} />
      <Input
        id={props.id}
        surface="background"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder="sk-…"
      />
      <span className="text-11px text-muted-foreground">{props.hint}</span>
    </label>
  );
}

/**
 * Key field on a saved instance. The server redacts a stored key, so the
 * input stays empty and says a key is stored; committing an empty value
 * leaves the stored key alone, and Remove clears it.
 */
export function CustomApiKeyField(props: {
  readonly id: string;
  readonly variable: ProviderInstanceEnvironmentVariable | undefined;
  readonly hint: string;
  readonly required: boolean;
  readonly onCommit: (value: string) => void;
  readonly onRemove: () => void;
}) {
  const stored =
    props.variable !== undefined && (props.variable.valueRedacted || props.variable.value !== "");

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={props.id}>
          <KeyLabel required={props.required} />
        </label>
        {stored ? (
          <Button type="button" size="xs" variant="ghost" onClick={props.onRemove}>
            Remove key
          </Button>
        ) : null}
      </div>
      <DraftInput
        id={props.id}
        className="mt-1.5"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value=""
        onCommit={(value) => {
          if (value.trim().length > 0) props.onCommit(value);
        }}
        placeholder={stored ? "Key stored securely. Type a new one to replace it." : "sk-…"}
      />
      <span className="mt-1 block text-xs text-muted-foreground">{props.hint}</span>
    </div>
  );
}
