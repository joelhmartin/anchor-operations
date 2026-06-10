import { RouterProvider } from 'react-router-dom';

// routing
import router from 'routes';

// project imports
import NavigationScroll from 'layout/NavigationScroll';

import ThemeCustomization from 'themes';

import { AuthProvider } from 'contexts/AuthContext';
import { ToastProvider } from 'contexts/ToastContext';

// ==============================|| APP ||============================== //

export default function App() {
  return (
    <ThemeCustomization>
      <ToastProvider>
        <AuthProvider>
          <NavigationScroll>
            <>
              <RouterProvider router={router} />
            </>
          </NavigationScroll>
        </AuthProvider>
      </ToastProvider>
    </ThemeCustomization>
  );
}
