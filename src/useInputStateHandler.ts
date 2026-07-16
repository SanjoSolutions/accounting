import { useCallback, useState } from 'react'

export function useInputStateHandler<T>(defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>, (event: any) => void] {
  const [value, setValue] = useState(defaultValue)
  const onChange = useCallback(
    (event: any) => {
      const value = event.target.value
      setValue(value)
    },
    []
  )
  return [value, setValue, onChange]
}
