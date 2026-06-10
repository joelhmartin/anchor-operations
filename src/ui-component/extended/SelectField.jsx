import PropTypes from 'prop-types';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';

/**
 * SelectField — wraps FormControl + InputLabel + Select into a single component.
 *
 * Accepts either an `options` array for simple cases or `children` for custom MenuItems.
 *
 * Usage:
 *   <SelectField label="Role" value={role} onChange={handleChange}
 *     options={[{ value: 'admin', label: 'Admin' }, { value: 'member', label: 'Member' }]} />
 *
 *   <SelectField label="Client" value={clientId} onChange={handleChange} required>
 *     {clients.map(c => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
 *   </SelectField>
 */
export default function SelectField({
  label,
  value,
  onChange,
  options,
  children,
  required,
  fullWidth = true,
  size,
  disabled,
  sx,
  ...selectProps
}) {
  return (
    <FormControl fullWidth={fullWidth} required={required} size={size} sx={sx}>
      {label && <InputLabel>{label}</InputLabel>}
      <Select
        value={value}
        onChange={onChange}
        label={label}
        disabled={disabled}
        {...selectProps}
      >
        {options
          ? options.map((opt) => {
              const optValue = typeof opt === 'string' ? opt : opt.value;
              const optLabel = typeof opt === 'string' ? opt : opt.label;
              return (
                <MenuItem key={optValue} value={optValue} disabled={opt.disabled}>
                  {optLabel}
                </MenuItem>
              );
            })
          : children}
      </Select>
    </FormControl>
  );
}

SelectField.propTypes = {
  label: PropTypes.string,
  value: PropTypes.any,
  onChange: PropTypes.func,
  options: PropTypes.arrayOf(
    PropTypes.oneOfType([
      PropTypes.string,
      PropTypes.shape({ value: PropTypes.any.isRequired, label: PropTypes.node.isRequired, disabled: PropTypes.bool })
    ])
  ),
  children: PropTypes.node,
  required: PropTypes.bool,
  fullWidth: PropTypes.bool,
  size: PropTypes.string,
  disabled: PropTypes.bool,
  sx: PropTypes.object
};
