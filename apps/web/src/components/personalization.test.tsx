import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { PublicUser } from '@private-chat/contracts';
import { AvatarEditor } from './AvatarEditor';
import { AvatarPreview } from './AvatarPreview';
import { ThemePicker } from './ThemePicker';
import { ProfileDialog } from './ProfileDialog';
import { DEFAULT_THEME, THEMES, useTheme } from '../lib/themes';

const me: PublicUser = {
  id: '11111111-1111-4111-8111-111111111111', username: 'adminqa', displayName: 'Miembro',
  role: 'admin', avatarUrl: null, avatarVersion: 0, mustChangePassword: false,
  updatedAt: '2026-10-10T12:00:00.000Z',
};
const revoke = vi.fn();
const setUser = vi.hoisted(() => vi.fn());
vi.mock('../state/session', () => ({
  useSession: () => ({ user: me, csrfToken: 'csrf-test-token-for-preview', setUser,
    logout: vi.fn(), changePassword: vi.fn(), busy: false }),
}));
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Node 26 expone un localStorage sin archivo; usar almacenamiento del entorno
  // de prueba para que no sustituya al almacenamiento real del navegador.
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:avatar-preview');
    static revokeObjectURL = revoke;
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); delete document.documentElement.dataset.theme; });

function editor() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const view = render(<AvatarEditor me={me} csrfToken="csrf-test-token-for-preview" onSaved={onSaved} onClose={onClose} />);
  return { ...view, onSaved, onClose };
}
function choose(file = new File(['image fixture'], 'avatar.png', { type: 'image/png' })) {
  fireEvent.change(screen.getByLabelText('Seleccionar nueva imagen'), { target: { files: [file] } });
}

describe('vista previa del avatar', () => {
  it('la foto ajena usa la versión actual, muestra ausencia o error y no modifica el perfil', () => {
    const other = { ...me, id: '22222222-2222-4222-8222-222222222222', displayName: 'Administrador' };
    const view = render(<AvatarPreview user={other} onClose={vi.fn()} />);
    expect(screen.getByText('No tiene foto de perfil.')).toBeInTheDocument();
    const withPhoto = { ...other, avatarUrl: `/api/users/${other.id}/avatar?v=1`, avatarVersion: 1 };
    view.rerender(<AvatarPreview user={withPhoto} onClose={vi.fn()} />);
    fireEvent.error(screen.getByRole('img', { name: 'Foto de perfil de Administrador' }));
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cargar la foto.');
    const updated = { ...withPhoto, avatarUrl: `/api/users/${other.id}/avatar?v=2`, avatarVersion: 2 };
    view.rerender(<AvatarPreview user={updated} onClose={vi.fn()} />);
    expect(screen.getByRole('img', { name: 'Foto de perfil de Administrador' })).toHaveAttribute('src', updated.avatarUrl);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('elegir y cancelar una imagen no envía ni cambia el perfil', () => {
    const { onSaved, onClose, unmount } = editor();
    choose();
    expect(screen.getByRole('img', { name: 'Foto de perfil de Miembro' })).toHaveAttribute('src', 'blob:avatar-preview');
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:avatar-preview');
  });

  it('guarda sólo tras decodificar y confirmar, con cookies, CSRF y multipart del contrato', async () => {
    const { onSaved, onClose } = editor();
    choose();
    const save = screen.getByRole('button', { name: 'Guardar imagen' });
    expect(save).toBeDisabled();
    fireEvent.load(screen.getByRole('img'));
    const updated = { ...me, avatarUrl: `/api/users/${me.id}/avatar?v=1`, avatarVersion: 1 };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ user: updated }), { status: 200 }));
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [route, options] = fetchMock.mock.calls[0]!;
    expect(route).toBe('/api/users/me/avatar');
    expect(options).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': 'csrf-test-token-for-preview' } });
    expect(options.body.get('avatar').name).toBe('avatar.png');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('rechaza SVG antes de crear una vista previa y no sube imágenes que no se pueden decodificar', () => {
    editor();
    choose(new File(['<svg/>'], 'avatar.svg', { type: 'image/svg+xml' }));
    expect(screen.getByRole('alert')).toHaveTextContent('JPEG, PNG o WebP');
    expect(screen.queryByRole('button', { name: 'Guardar imagen' })).not.toBeInTheDocument();
    choose();
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByRole('button', { name: 'Guardar imagen' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mantiene la vista previa tras un fallo del servidor para permitir reintentar', async () => {
    const { onSaved, onClose } = editor();
    choose(); fireEvent.load(screen.getByRole('img'));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Servidor no disponible' } }), { status: 503 }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar imagen' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Guardar imagen' })).toBeEnabled();
    expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });
});

describe('personalización por cuenta', () => {
  it('el lápiz enfoca el nombre y guardar modifica únicamente el perfil propio con CSRF', async () => {
    render(<ProfileDialog me={me} theme="github-light" onChooseTheme={vi.fn()} avatarOpen={false}
      onOpenAvatar={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Editar nombre de Miembro' }));
    const name = screen.getByRole('textbox', { name: 'Nombre visible' });
    expect(name).toHaveFocus();
    fireEvent.change(name, { target: { value: 'Miembro Actualizado' } });
    const updated = { ...me, displayName: 'Miembro Actualizado' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ user: updated }), { status: 200 }));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar perfil' }));
    await waitFor(() => expect(setUser).toHaveBeenCalledWith(updated));
    const [route, options] = fetchMock.mock.calls[0]!;
    expect(route).toBe('/api/users/me');
    expect(options).toMatchObject({ method: 'PATCH', credentials: 'include', headers: { 'X-CSRF-Token': 'csrf-test-token-for-preview' } });
    expect(JSON.parse(options.body)).toEqual({ displayName: 'Miembro Actualizado' });
  });

  it('el diálogo de ajustes expone el selector de temas', () => {
    render(<ProfileDialog me={me} theme="github-light" onChooseTheme={vi.fn()} avatarOpen={false}
      onOpenAvatar={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Elige el tema del chat' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(THEMES.length);
  });

  it('muestra todos los temas seleccionables del catálogo', () => {
    const onChange = vi.fn();
    render(<ThemePicker theme="github-light" onChange={onChange} />);
    expect(screen.getAllByRole('radio')).toHaveLength(THEMES.length);
    fireEvent.click(screen.getByRole('radio', { name: /Dracula/ }));
    expect(onChange).toHaveBeenCalledWith('dracula');
  });

  it('recuerda el tema tras recargar, separa las cuentas y rechaza preferencias desconocidas', () => {
    const first = renderHook(({ id }) => useTheme(id), { initialProps: { id: 'account-one' } });
    act(() => first.result.current.chooseTheme('tokyo-night'));
    expect(document.documentElement.dataset.theme).toBe('tokyo-night');
    first.unmount();
    const next = renderHook(({ id }) => useTheme(id), { initialProps: { id: 'account-one' } });
    expect(next.result.current.theme).toBe('tokyo-night');
    next.rerender({ id: 'account-two' });
    expect(next.result.current.theme).toBe(DEFAULT_THEME);
    window.localStorage.setItem('private-chat:theme:account-three', 'unrecognized-theme');
    next.rerender({ id: 'account-three' });
    expect(next.result.current.theme).toBe(DEFAULT_THEME);
  });
});
