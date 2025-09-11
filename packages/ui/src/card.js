import PropTypes from 'prop-types';

export function Card({ className, title, children, href, }) {
  return (<a className={className} href={`${href}?utm_source=create-turbo&utm_medium=basic&utm_campaign=create-turbo"`} rel="noopener noreferrer" target="_blank">
    <h2>
      {title} <span>-&gt;</span>
    </h2>
    <p>{children}</p>
  </a>);
}

Card.propTypes = {
  className: PropTypes.string,
  title: PropTypes.string,
  children: PropTypes.node,
  href: PropTypes.string,
};
