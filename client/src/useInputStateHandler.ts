import { identity } from '@sanjo/identity'
import { useCallback, useState } from 'react'

export function useInputStateHandler(options: { name: string, data: any, transform?: (value: any) => any }): [any, (event: any) => void] {
  const transform = options.transform ?? identity

  const [value, setValue] = useState(options.data[options.name])
  const onChange = useCallback(
    (event: any) => {
      const value = event.target.value
      setValue(value)
      options.data[options.name] = transform(value)
    },
    [
      options,
      transform,
    ],
  )
  return [value, onChange]
}
