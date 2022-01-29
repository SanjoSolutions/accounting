export function Row({ onRemove }: { onRemove: () => void }) {
  return (
    <tr>
      <td>
        <input
          type="date"
          className="form-control"
        />
      </td>
      <td>
        <input
          type="text"
          className="form-control"
        />
      </td>
      <td>
        <div className="d-flex">
          <select className="form-select me-2" style={ { width: 'auto' } } defaultValue="">
            <option value=""></option>
            <option value="to">to</option>
          </select>
          <input
            type="text"
            className="form-control flex-grow-1"
          />
        </div>
      </td>
      <td>
        <input
          type="number"
          className="form-control"
        />
      </td>
      <td>
        <input
          type="number"
          className="form-control"
        />
      </td>
      <td>
        <button type="button" className="btn btn-secondary" onClick={ onRemove }>
          <i className="bi bi-x-lg"></i>
        </button>
      </td>
    </tr>
  )
}
