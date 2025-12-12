import type { FieldError } from 'react-hook-form';
import type { InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactElement, ReactNode } from 'react';
import { forwardRef, useId, isValidElement, cloneElement } from 'react';

interface FormFieldProps {
  label?: string;
  error?: FieldError;
  children: ReactNode;
  /** Optional custom ID for the field. If not provided, one will be auto-generated. */
  fieldId?: string;
}

/**
 * Form field wrapper with label and error display.
 * Provides accessibility features including:
 * - Label association via htmlFor/id
 * - Error message association via aria-describedby
 * - Invalid state indication via aria-invalid
 */
export function FormField({ label, error, children, fieldId }: FormFieldProps) {
  const generatedId = useId();
  const id = fieldId ?? generatedId;
  const errorId = `${id}-error`;

  // Clone child element to inject accessibility props
  const enhancedChildren = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }>, {
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': error ? errorId : undefined,
      })
    : children;

  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={id} className="text-sm text-gray-400">{label}</label>
      )}
      {enhancedChildren}
      {error && (
        <p id={errorId} className="text-sm text-red-400" role="alert">{error.message}</p>
      )}
    </div>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: FieldError;
}

/**
 * Input with error styling and accessibility support
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ error, className = '', 'aria-invalid': ariaInvalid, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={`input ${error ? 'border-red-500' : ''} ${className}`}
        aria-invalid={ariaInvalid ?? (error ? true : undefined)}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: FieldError;
}

/**
 * Textarea with error styling and accessibility support
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ error, className = '', 'aria-invalid': ariaInvalid, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={`input ${error ? 'border-red-500' : ''} ${className}`}
        aria-invalid={ariaInvalid ?? (error ? true : undefined)}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: FieldError;
}

/**
 * Select with error styling and accessibility support
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ error, className = '', children, 'aria-invalid': ariaInvalid, ...props }, ref) => {
    return (
      <select
        ref={ref}
        className={`input ${error ? 'border-red-500' : ''} ${className}`}
        aria-invalid={ariaInvalid ?? (error ? true : undefined)}
        {...props}
      >
        {children}
      </select>
    );
  }
);
Select.displayName = 'Select';
