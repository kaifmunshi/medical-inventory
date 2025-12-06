import { TextField } from '@mui/material';
import type { TextFieldProps } from '@mui/material';


export default function NumberInput(props: TextFieldProps) {
return <TextField type="number" inputProps={{ step: 'any' }} {...props} />
}