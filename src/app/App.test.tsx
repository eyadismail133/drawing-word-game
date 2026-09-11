import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('App shell', () => {
  it('shows the Draw Party brand while the session starts', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: /draw party/i })).toBeInTheDocument()
  })
})
