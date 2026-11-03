"use client";

import {
  createContext,
  useContext,
  useId,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils/cn";

interface FieldContextValue {
  controlId: string;
  helperId: string;
  errorId: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

interface ControlProps {
  id?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
  "aria-describedby"?: string;
}

function controlProps(field: FieldContextValue | null, id: string | undefined): ControlProps {
  return {
    id: id ?? field?.controlId,
    "aria-invalid": field?.invalid ? true : undefined,
    "aria-required": field?.required ? true : undefined,
    "aria-describedby": field?.describedBy,
  };
}

const CONTROL_CLASSES = [
  "w-full rounded-control border border-line-strong bg-black/30 px-3 text-sm text-fg",
  "placeholder:text-fg-subtle transition-colors duration-fast ease-standard",
  "aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:opacity-50",
];

export function Input({ id, className, ...rest }: ComponentProps<"input">): ReactElement {
  const field = useContext(FieldContext);
  return (
    <input
      {...rest}
      {...controlProps(field, id)}
      className={cn(CONTROL_CLASSES, "min-h-control", className)}
    />
  );
}

export function Textarea({ id, className, ...rest }: ComponentProps<"textarea">): ReactElement {
  const field = useContext(FieldContext);
  return (
    <textarea
      {...rest}
      {...controlProps(field, id)}
      className={cn(CONTROL_CLASSES, "min-h-control py-2.5", className)}
    />
  );
}

interface LabelProps extends ComponentProps<"label"> {
  required?: boolean;
}

export function Label({ required, className, children, ...rest }: LabelProps): ReactElement {
  const field = useContext(FieldContext);
  return (
    <label
      {...rest}
      htmlFor={rest.htmlFor ?? field?.controlId}
      className={cn("block text-sm font-medium text-fg", className)}
    >
      {children}
      {required && (
        <span aria-hidden="true" className="ml-1 text-danger-fg">
          *
        </span>
      )}
    </label>
  );
}

export function HelperText({ className, ...rest }: ComponentProps<"div">): ReactElement {
  const field = useContext(FieldContext);
  return <div {...rest} id={field?.helperId} className={cn("text-xs text-fg-muted", className)} />;
}

export function FieldError({ className, children, ...rest }: ComponentProps<"p">): ReactElement {
  const field = useContext(FieldContext);
  return (
    <p
      {...rest}
      id={field?.errorId}
      role="alert"
      className={cn("flex items-center gap-1 text-xs text-danger-fg", className)}
    >
      <AlertCircle aria-hidden="true" className="h-3 w-3 shrink-0" />
      {children}
    </p>
  );
}

interface FieldProps {
  label: ReactNode;
  hideLabel?: boolean;
  required?: boolean;
  helper?: ReactNode;
  error?: ReactNode;
  /** Read to assistive technology only, in place of a visual-only valid state. Ignored while
   *  `error` is set. */
  status?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** The helper and error arrive as props rather than as children so `aria-describedby` is right on
 *  the first render and can never name an element that is not on the page. */
export function Field({
  label,
  hideLabel = false,
  required = false,
  helper,
  error,
  status,
  className,
  children,
}: FieldProps): ReactElement {
  const id = useId();
  const invalid = !!error;
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const statusId = `${id}-status`;
  const settled = !invalid && !!status;
  const described = [invalid && errorId, settled && statusId, helper && helperId]
    .filter(Boolean)
    .join(" ");
  const context: FieldContextValue = {
    controlId: `${id}-control`,
    helperId,
    errorId,
    describedBy: described || undefined,
    invalid,
    required,
  };

  return (
    <FieldContext.Provider value={context}>
      <div className={cn("space-y-1.5", className)}>
        <Label required={required} className={hideLabel ? "sr-only" : undefined}>
          {label}
        </Label>
        {children}
        {invalid && <FieldError>{error}</FieldError>}
        {settled && (
          <span id={statusId} className="sr-only">
            {status}
          </span>
        )}
        {helper && <HelperText>{helper}</HelperText>}
      </div>
    </FieldContext.Provider>
  );
}
