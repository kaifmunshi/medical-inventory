import { TextField } from '@mui/material';
import type { TextFieldProps } from '@mui/material';


export default function NumberInput(props: TextFieldProps) {
  const { inputProps, onWheel, ...rest } = props;

  const handleWheel: NonNullable<TextFieldProps['onWheel']> = (event) => {
    event.currentTarget.blur();
    onWheel?.(event);
  };

  return <TextField type="number" inputProps={{ step: 'any', ...inputProps }} onWheel={handleWheel} {...rest} />
}
